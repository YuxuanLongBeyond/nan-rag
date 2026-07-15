#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSearchTerms, rankCandidates } from "../server/search-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXACT_CASES = [
  "知止而后有定",
  "君心正闹在，且自休去",
  "知之为知之，不知为不知",
];
const FUZZY_CASES = [
  { query: "南怀瑾如何理解安那般那", expectedGroups: [["安那般那", "安般"]] },
  { query: "什么是十六特胜", expectedGroups: [["十六特胜"]] },
  {
    query: "打坐时腿麻怎么办",
    expectedGroups: [["打坐", "静坐"], ["腿麻", "发麻", "麻胀", "两腿"]],
  },
  {
    query: "孔子为什么强调仁",
    expectedGroups: [["孔子"], ["仁者", "仁爱", "仁义", "不仁", "仁的", "仁道", "仁心"]],
  },
];
const SEMANTIC_CASES = [
  {
    query: "脑子停不下来，晚上翻来覆去怎么办",
    terms: ["数息", "安那般那", "出入息", "静坐"],
  },
  {
    query: "人走到生命终点以后会经历什么",
    terms: ["中阴", "投生", "轮回", "六道"],
  },
  {
    query: "总控制不住脾气，跟人冲突后怎么办",
    terms: ["嗔心", "瞋恨", "忍辱", "观心"],
  },
];

function loadRows() {
  const manifestPath = path.join(ROOT, "works_manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error("缺少 works_manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const rows = [];
  for (const [work, info] of Object.entries(manifest)) {
    const corpusPath = path.join(ROOT, info.file);
    if (!fs.existsSync(corpusPath)) {
      throw new Error(`缺少本地语料 ${info.file}，请先运行语料构建脚本`);
    }
    for (const [id, item] of Object.entries(JSON.parse(fs.readFileSync(corpusPath, "utf8")))) {
      rows.push({
        id,
        work,
        chapter: item.c || "",
        content: item.t || "",
        source_url: item.u || "",
        char_count: String(item.t || "").length,
        db_score: 0,
      });
    }
  }
  return rows;
}

function rowText(row) {
  return `${row.work} ${row.chapter} ${row.content}`;
}

function candidatesFor(rows, terms, perTerm = 140) {
  const candidates = new Map();
  for (const term of terms) {
    let count = 0;
    for (const row of rows) {
      const text = rowText(row);
      if (!text.includes(term)) continue;
      const dbScore = row.work.includes(term) ? 1 : row.chapter.includes(term) ? 0.96 : 0.9;
      const previous = candidates.get(row.id);
      if (!previous || dbScore > previous.db_score) {
        candidates.set(row.id, { ...row, db_score: dbScore });
      }
      count += 1;
      if (count >= perTerm) break;
    }
  }
  return [...candidates.values()];
}

const rows = loadRows();
let passed = 0;
let total = 0;

console.log("精准检索");
for (const query of EXACT_CASES) {
  total += 1;
  const exactRows = rows
    .filter((row) => rowText(row).includes(query))
    .slice(0, 500)
    .map((row) => ({ ...row, db_score: 0.9 }));
  const ranked = rankCandidates(exactRows, query, "exact", 8, 0);
  const top = ranked[0]?.row;
  if (!top || !rowText(top).includes(query)) throw new Error(`精准检索失败：${query}`);
  passed += 1;
  console.log(`  ✓ ${query} → ${top.work} / ${top.chapter}`);
}

console.log("模糊检索");
for (const item of FUZZY_CASES) {
  total += 1;
  const terms = buildSearchTerms(item.query);
  const candidates = candidatesFor(rows, terms);
  const ranked = rankCandidates(candidates, item.query, "fuzzy", 8, 0);
  const top = ranked[0]?.row;
  const topText = top ? rowText(top) : "";
  const matched = item.expectedGroups.map((group) => group.find((term) => topText.includes(term)));
  if (!top || matched.some((term) => !term) || candidates.length < 3) {
    throw new Error(`模糊检索失败：${item.query}`);
  }
  passed += 1;
  console.log(`  ✓ ${item.query} → ${top.work} / ${top.chapter}（命中“${matched.join("、")}”）`);
}

console.log("语义检索");
for (const item of SEMANTIC_CASES) {
  total += 1;
  const candidates = candidatesFor(rows, item.terms);
  const ranked = rankCandidates(candidates, item.query, "semantic", 8, 0, item.terms);
  const top = ranked[0]?.row;
  const matched = top && item.terms.find((term) => rowText(top).includes(term));
  if (!top || !matched || candidates.length < 3) throw new Error(`语义检索失败：${item.query}`);
  passed += 1;
  console.log(`  ✓ ${item.query} → ${top.work} / ${top.chapter}（命中“${matched}”）`);
}

console.log(`检索质量评测通过：${passed}/${total}；语料 ${rows.length.toLocaleString()} 条`);
