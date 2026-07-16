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
  let skipEmbeddings = false;
  let embeddingsOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--dry-run") dryRun = true;
    if (args[i] === "--skip-embeddings") skipEmbeddings = true;
    if (args[i] === "--embeddings-only") embeddingsOnly = true;
    if (args[i] === "--batch-size") batchSize = Number(args[++i]);
  }
  if (!Number.isInteger(batchSize) || batchSize < 50 || batchSize > 1000) {
    throw new Error("--batch-size 必须是 50–1000 的整数");
  }
  if (skipEmbeddings && embeddingsOnly) {
    throw new Error("--skip-embeddings 与 --embeddings-only 不能同时使用");
  }
  return { batchSize, dryRun, skipEmbeddings, embeddingsOnly };
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

function openEmbeddings(index, versionInfo) {
  const embeddingInfo = versionInfo.embeddings;
  const file = path.join(ROOT, "embeddings.bin");
  if (!embeddingInfo || !fs.existsSync(file)) return null;
  const buffer = fs.readFileSync(file);
  if (buffer.length < 12) throw new Error("embeddings.bin 文件不完整");
  const dim = buffer.readUInt32LE(0);
  const count = (buffer.length - 12) / dim;
  if (!Number.isInteger(count) || dim !== 384 || count !== index.length) {
    throw new Error(
      `向量与当前索引不匹配：${count}×${dim}，索引 ${index.length} 条`,
    );
  }
  if (Number(embeddingInfo.count) !== count || Number(embeddingInfo.dim) !== dim) {
    throw new Error("index_version.json 中的向量元数据与文件不一致");
  }
  const min = buffer.readFloatLE(buffer.length - 8);
  const max = buffer.readFloatLE(buffer.length - 4);
  return { buffer, count, dim, min, scale: (max - min) / 255, info: embeddingInfo };
}

function embeddingBatch(index, embeddings, offset, batchSize) {
  const end = Math.min(index.length, offset + batchSize);
  const rows = [];
  for (let i = offset; i < end; i += 1) {
    const values = new Array(embeddings.dim);
    const base = 4 + i * embeddings.dim;
    for (let d = 0; d < embeddings.dim; d += 1) {
      values[d] = (embeddings.buffer[base + d] * embeddings.scale + embeddings.min).toFixed(6);
    }
    rows.push({ id: index[i].id, embedding: `[${values.join(",")}]` });
  }
  return rows;
}

async function main() {
  loadLocalEnv();
  const { batchSize, dryRun, skipEmbeddings, embeddingsOnly } = getOptions();
  const index = readJson("search_index.json");
  const manifest = readJson("works_manifest.json");
  const versionInfo = readJson("index_version.json");
  const version = versionInfo.v || `local-${Date.now()}`;
  const makeRows = buildRows(index, manifest);
  const embeddings = skipEmbeddings ? null : openEmbeddings(index, versionInfo);
  if (!skipEmbeddings && !embeddings) {
    throw new Error(
      "缺少与当前索引匹配的向量；请先运行 python3 rag/build_static_corpus.py --embeddings-only，或显式使用 --skip-embeddings",
    );
  }
  if (embeddingsOnly && !embeddings) {
    throw new Error("--embeddings-only 需要与当前索引匹配的 embeddings.bin");
  }

  console.log(`准备导入 ${index.length.toLocaleString()} 个片段、${Object.keys(manifest).length} 部作品`);
  console.log(`数据版本：${version}，批大小：${batchSize}`);
  console.log(embeddings
    ? `语义向量：${embeddings.count.toLocaleString()} 条 × ${embeddings.dim} 维（${embeddings.info.model}）`
    : "语义向量：本次跳过");
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
  let searchIndexDropped = false;
  try {
    const schema = fs.readFileSync(path.join(ROOT, "db/schema.sql"), "utf8");
    console.log("初始化数据库结构...");
    await client.query(schema);
    // 大批量 UPDATE 会为所有索引产生新版本。先移除可重建的模糊索引，
    // 避免仅导入 embedding 就把 GiST 体积翻倍并挤满 Neon 免费容量。
    await client.query("DROP INDEX IF EXISTS rag_chunks_search_trgm_gist_idx");
    searchIndexDropped = true;

    if (!embeddingsOnly) {
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
    } else {
      const { rows: current } = await client.query(
        "SELECT count(*)::int AS count, min(build_version) AS version FROM rag_chunks",
      );
      if (current[0]?.count !== index.length || current[0]?.version !== version) {
        throw new Error(
          `线上语料与本地索引不一致：${current[0]?.count} 条，版本 ${current[0]?.version}`,
        );
      }
    }

    if (embeddings) {
      console.log("导入语义向量...");
      await client.query("DROP INDEX IF EXISTS rag_chunks_embedding_hnsw_idx");
      const vectorBatchSize = Math.min(batchSize, 1000);
      for (let offset = 0; offset < index.length; offset += vectorBatchSize) {
        const batch = embeddingBatch(index, embeddings, offset, vectorBatchSize);
        await client.query(
          `UPDATE rag_chunks AS c
           SET embedding = x.embedding::halfvec(384), updated_at = now()
           FROM jsonb_to_recordset($1::jsonb) AS x(id text, embedding text)
           WHERE c.id = x.id`,
          [JSON.stringify(batch)],
        );
        if ((offset + vectorBatchSize) % 5000 < vectorBatchSize) {
          console.log(`  ${Math.min(offset + vectorBatchSize, index.length).toLocaleString()} / ${index.length.toLocaleString()}`);
        }
      }
      const { rows: vectorRows } = await client.query(
        "SELECT count(*)::int AS count FROM rag_chunks WHERE embedding IS NOT NULL",
      );
      if (vectorRows[0]?.count !== index.length) {
        throw new Error(`向量导入后条数异常：${vectorRows[0]?.count} / ${index.length}`);
      }
      console.log("创建 HNSW 向量索引...");
      await client.query(`
        CREATE INDEX rag_chunks_embedding_hnsw_idx
        ON rag_chunks USING hnsw (embedding halfvec_cosine_ops)
        WITH (m = 12, ef_construction = 64)
        WHERE embedding IS NOT NULL
      `);
    } else if (skipEmbeddings) {
      console.log("移除旧向量，避免语料更新后发生错配...");
      await client.query("DROP INDEX IF EXISTS rag_chunks_embedding_hnsw_idx");
      await client.query("UPDATE rag_chunks SET embedding = NULL WHERE embedding IS NOT NULL");
    }

    console.log("确认紧凑型中文模糊检索索引...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS rag_chunks_search_trgm_gist_idx
      ON rag_chunks USING gist
      ((lower(work || ' ' || chapter || ' ' || content)) gist_trgm_ops(siglen=64))
    `);
    searchIndexDropped = false;
    await client.query("ANALYZE rag_chunks");

    const corpusBytes = Object.values(manifest)
      .reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    const meta = {
      version,
      chunks: index.length,
      works: Object.keys(manifest).length,
      corpusBytes,
      embeddings: embeddings ? {
        count: embeddings.count,
        dim: embeddings.dim,
        model: embeddings.info.model,
      } : null,
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
    if (searchIndexDropped) {
      try {
        console.log("恢复中文模糊检索索引...");
        await client.query(`
          CREATE INDEX IF NOT EXISTS rag_chunks_search_trgm_gist_idx
          ON rag_chunks USING gist
          ((lower(work || ' ' || chapter || ' ' || content)) gist_trgm_ops(siglen=64))
        `);
      } catch (error) {
        console.error(`索引恢复失败，请重新运行导入：${error.message}`);
      }
    }
    await client.end();
  }
}

main().catch((error) => {
  console.error(`导入失败：${error.message}`);
  process.exitCode = 1;
});
