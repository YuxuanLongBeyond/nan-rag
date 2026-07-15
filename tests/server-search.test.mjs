import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSearchTerms,
  mergeCandidateSets,
  normalizeQuery,
  rankCandidates,
} from "../server/search-core.mjs";

test("服务端查询会去除问句套话", () => {
  assert.equal(normalizeQuery("南怀瑾如何理解安那般那？"), "安那般那");
  assert.deepEqual(buildSearchTerms("南怀瑾如何理解安那般那？")[0], "安那般那");
});

test("并列概念会拆成可召回的独立搜索词", () => {
  const terms = buildSearchTerms("中脉与修持");
  assert(terms.includes("中脉"));
  assert(terms.includes("修持"));
});

test("多个数据库候选集合按 id 去重并保留较高分", () => {
  const merged = mergeCandidateSets([
    [{ id: "a", db_score: 0.2 }],
    [{ id: "a", db_score: 0.8 }, { id: "b", db_score: 0.3 }],
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((row) => row.id === "a").db_score, 0.8);
});

test("服务端精排优先返回主题匹配片段并限制章节重复", () => {
  const rows = [
    { id: "noise", work: "历史的经验", chapter: "前言", content: "文化与人生", db_score: 0.3 },
    { id: "hit1", work: "定慧初修", chapter: "安般法门", content: "安那般那是修习出入息的重要法门。", db_score: 0.9 },
    { id: "hit2", work: "定慧初修", chapter: "安般法门", content: "修习安那般那需要注意呼吸。", db_score: 0.8 },
    { id: "hit3", work: "定慧初修", chapter: "安般法门", content: "这是同章节的第三个相邻片段。", db_score: 0.7 },
    { id: "other", work: "如何修证佛法", chapter: "呼吸", content: "出入息与修持。", db_score: 0.5 },
  ];
  const ranked = rankCandidates(rows, "什么是安那般那", "fuzzy", 3, 0);
  assert.equal(ranked[0].row.id, "hit1");
  assert(ranked.some(({ row }) => row.id === "other"));
});
