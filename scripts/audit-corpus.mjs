#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const reportArg = args.indexOf("--report");
const reportPath = reportArg >= 0 ? args[reportArg + 1] : "rag/corpus_quality_report.json";
const strict = args.includes("--strict");

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, "");
}

function makeIssueStore() {
  const counts = new Map();
  const samples = new Map();
  return {
    add(code, sample) {
      counts.set(code, (counts.get(code) || 0) + 1);
      if (!samples.has(code)) samples.set(code, []);
      if (samples.get(code).length < 12) samples.get(code).push(sample);
    },
    json() {
      return Object.fromEntries([...counts].sort().map(([code, count]) => [
        code,
        { count, samples: samples.get(code) },
      ]));
    },
  };
}

const index = readJson("search_index.json");
const manifest = readJson("works_manifest.json");
const issues = makeIssueStore();
const seenIds = new Set();
const seenTextsByWork = new Map();
let totalChars = 0;
let corpusChunks = 0;

for (const [work, info] of Object.entries(manifest)) {
  const corpusPath = path.join(ROOT, info.file);
  if (!fs.existsSync(corpusPath)) {
    issues.add("MISSING_CORPUS_FILE", { work, file: info.file });
    continue;
  }
  const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  const entries = Object.entries(corpus);
  corpusChunks += entries.length;
  if (entries.length !== Number(info.chunks)) {
    issues.add("MANIFEST_COUNT_MISMATCH", { work, manifest: info.chunks, actual: entries.length });
  }

  const seenTexts = seenTextsByWork.get(work) || new Set();
  seenTextsByWork.set(work, seenTexts);
  for (const [id, entry] of entries) {
    const text = String(entry.t || "");
    const compact = normalizeText(text);
    totalChars += text.length;
    if (seenIds.has(id)) issues.add("DUPLICATE_ID", { work, id });
    seenIds.add(id);
    if (!compact) issues.add("EMPTY_TEXT", { work, id });
    if (compact.length < 20) issues.add("VERY_SHORT_TEXT", { work, id, text });
    if (seenTexts.has(compact)) issues.add("EXACT_DUPLICATE_IN_WORK", { work, id });
    seenTexts.add(compact);

    if (/�/.test(text)) issues.add("REPLACEMENT_CHARACTER", { work, id, text: text.slice(0, 160) });
    if (/!\[[^\]]*\]\(|<\/?[a-z][^>]*>/i.test(text)) {
      issues.add("MARKUP_RESIDUE", { work, id, text: text.slice(0, 160) });
    }
    if (/\\(?:textcircled|bigcirc|mathbf|mathbb)|\$[^$]+\$/.test(text)) {
      issues.add("LATEX_RESIDUE", { work, id, text: text.slice(0, 160) });
    }
    if (/图书在版编目|版权所有·侵权必究|东方出版社南怀瑾作品/.test(text)) {
      issues.add("PUBLISHER_BOILERPLATE", { work, id, text: text.slice(0, 180) });
    }
    if (/file:\/\/.*\/(?:Users|home)\//.test(String(entry.u || ""))) {
      issues.add("LOCAL_ABSOLUTE_PATH", { work, id, source: entry.u });
    }
    const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
    if (compact.length >= 100 && cjk / compact.length < 0.25) {
      issues.add("LOW_CJK_RATIO", { work, id, ratio: Number((cjk / compact.length).toFixed(3)), text: text.slice(0, 160) });
    }

    const meaningfulLines = text.split(/\n+/).map(normalizeText).filter((line) => line.length >= 16);
    if (meaningfulLines.length >= 3 && new Set(meaningfulLines).size < meaningfulLines.length) {
      issues.add("REPEATED_LINE_IN_CHUNK", { work, id, text: text.slice(0, 220) });
    }
  }
}

if (index.length !== corpusChunks) {
  issues.add("INDEX_CORPUS_COUNT_MISMATCH", { index: index.length, corpus: corpusChunks });
}
for (const item of index) {
  if (!seenIds.has(item.id)) issues.add("INDEX_ID_MISSING_FROM_CORPUS", { id: item.id, work: item.w });
  const previewChars = Array.from(String(item.p || "")).length;
  if (Number(item.n) < previewChars) {
    issues.add("INVALID_PREVIEW_LENGTH", { id: item.id, chars: item.n, preview: previewChars });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  summary: { works: Object.keys(manifest).length, indexChunks: index.length, corpusChunks, totalChars },
  issues: issues.json(),
};

const destination = path.resolve(ROOT, reportPath);
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);

console.log(`质量审计：${report.summary.works} 部作品 / ${report.summary.corpusChunks.toLocaleString()} 个片段 / ${report.summary.totalChars.toLocaleString()} 字`);
const issueEntries = Object.entries(report.issues);
if (!issueEntries.length) console.log("未发现结构、格式或明显噪声问题。");
for (const [code, value] of issueEntries) console.log(`  ${code}: ${value.count}`);
console.log(`报告：${path.relative(ROOT, destination)}`);

const severeCodes = [
  "MISSING_CORPUS_FILE", "MANIFEST_COUNT_MISMATCH", "DUPLICATE_ID", "EMPTY_TEXT",
  "REPLACEMENT_CHARACTER", "MARKUP_RESIDUE", "PUBLISHER_BOILERPLATE", "LOCAL_ABSOLUTE_PATH",
  "INDEX_CORPUS_COUNT_MISMATCH", "INDEX_ID_MISSING_FROM_CORPUS",
];
if (strict && severeCodes.some((code) => report.issues[code]?.count)) process.exitCode = 1;
