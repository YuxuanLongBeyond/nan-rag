#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@neondatabase/serverless";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadLocalEnv() {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  }
}

function getOptions() {
  const args = process.argv.slice(2);
  let batchSize = 400;
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--dry-run") dryRun = true;
    if (args[i] === "--batch-size") batchSize = Number(args[++i]);
  }
  if (!Number.isInteger(batchSize) || batchSize < 50 || batchSize > 1000) {
    throw new Error("--batch-size 必须是 50–1000 的整数");
  }
  return { batchSize, dryRun };
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));
}

function buildRows(index, manifest) {
  const byWork = new Map();
  index.forEach((item, indexPos) => {
    if (!byWork.has(item.w)) byWork.set(item.w, []);
    byWork.get(item.w).push({ ...item, indexPos });
  });

  return function* rowsByWork(version) {
    for (const [work, items] of byWork) {
      const info = manifest[work];
      if (!info) throw new Error(`works_manifest.json 缺少作品：${work}`);
      const corpusPath = path.join(ROOT, info.file);
      const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
      const rows = items.map((item) => {
        const entry = corpus[item.id];
        if (!entry) throw new Error(`${info.file} 缺少片段：${item.id}`);
        return {
          id: item.id,
          index_pos: item.indexPos,
          work: item.w,
          chapter: item.c || entry.c || "",
          content: entry.t || item.p || "",
          source_url: entry.u || "",
          char_count: Number(item.n) || String(entry.t || "").length,
          build_version: version,
        };
      });
      yield { work, rows };
    }
  };
}

async function main() {
  loadLocalEnv();
  const { batchSize, dryRun } = getOptions();
  const index = readJson("search_index.json");
  const manifest = readJson("works_manifest.json");
  const versionInfo = readJson("index_version.json");
  const version = versionInfo.v || `local-${Date.now()}`;
  const makeRows = buildRows(index, manifest);

  console.log(`准备导入 ${index.length.toLocaleString()} 个片段、${Object.keys(manifest).length} 部作品`);
  console.log(`数据版本：${version}，批大小：${batchSize}`);
  if (dryRun) {
    let checked = 0;
    for (const { rows } of makeRows(version)) checked += rows.length;
    console.log(`检查完成：${checked.toLocaleString()} 条数据均能关联到全文，未连接数据库`);
    return;
  }
  const importDatabaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!importDatabaseUrl) {
    throw new Error("缺少 DATABASE_URL_UNPOOLED；请复制 .env.example 为 .env.local 并填写 Neon 连接串");
  }

  const client = new Client(importDatabaseUrl);
  await client.connect();
  try {
    const schema = fs.readFileSync(path.join(ROOT, "db/schema.sql"), "utf8");
    console.log("初始化数据库结构...");
    await client.query(schema);

    // 首次导入时先移除空索引，完成后一次性建立更快；更新已有线上库时保留索引可用性。
    const { rows: existingRows } = await client.query(
      "SELECT EXISTS (SELECT 1 FROM rag_chunks LIMIT 1) AS has_rows",
    );
    if (!existingRows[0]?.has_rows) {
      await client.query("DROP INDEX IF EXISTS rag_chunks_search_trgm_idx");
    }

    let imported = 0;
    for (const { work, rows } of makeRows(version)) {
      await client.query("BEGIN");
      try {
        for (let offset = 0; offset < rows.length; offset += batchSize) {
          const batch = rows.slice(offset, offset + batchSize);
          await client.query(
            `INSERT INTO rag_chunks
              (id, index_pos, work, chapter, content, source_url, char_count, build_version)
             SELECT id, index_pos, work, chapter, content, source_url, char_count, build_version
             FROM jsonb_to_recordset($1::jsonb) AS x(
               id text,
               index_pos integer,
               work text,
               chapter text,
               content text,
               source_url text,
               char_count integer,
               build_version text
             )
             ON CONFLICT (id) DO UPDATE SET
               index_pos = EXCLUDED.index_pos,
               work = EXCLUDED.work,
               chapter = EXCLUDED.chapter,
               content = EXCLUDED.content,
               source_url = EXCLUDED.source_url,
               char_count = EXCLUDED.char_count,
               build_version = EXCLUDED.build_version,
               updated_at = now()`,
            [JSON.stringify(batch)],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      imported += rows.length;
      console.log(`  ${String(imported).padStart(6)} / ${index.length}  ${work}`);
    }

    // 只有完整导入成功后才清理旧版本，脚本中途失败不会破坏已有数据。
    await client.query("DELETE FROM rag_chunks WHERE build_version <> $1", [version]);
    console.log("创建中文模糊检索索引（通常需要几分钟）...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS rag_chunks_search_trgm_idx
      ON rag_chunks USING gin
      ((lower(work || ' ' || chapter || ' ' || content)) gin_trgm_ops)
    `);
    await client.query("ANALYZE rag_chunks");

    const corpusBytes = Object.values(manifest)
      .reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    const meta = {
      version,
      chunks: index.length,
      works: Object.keys(manifest).length,
      corpusBytes,
      importedAt: new Date().toISOString(),
    };
    await client.query(
      `INSERT INTO rag_meta (key, value, updated_at)
       VALUES ('corpus', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(meta)],
    );
    console.log(`导入完成：${index.length.toLocaleString()} 个片段，版本 ${version}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`导入失败：${error.message}`);
  process.exitCode = 1;
});
