import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSemanticSearchTerms,
  buildSearchTerms,
  mergeCandidateSets,
  normalizeQuery,
  normalizeSemanticTerms,
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

test("模糊查询会保留中文分词、尾部症状和领域单字概念", () => {
  assert(buildSearchTerms("打坐时腿麻怎么办").includes("打坐"));
  assert(buildSearchTerms("打坐时腿麻怎么办").includes("腿麻"));
  assert(buildSearchTerms("孔子为什么强调仁").includes("仁"));
});

test("语义搜索词包含经过约束的跨表达概念", () => {
  const normalized = normalizeSemanticTerms(
    ["数息", " 安那般那 ", "数息", "x", "心里很乱"],
    "心里很乱时怎样安定自己",
  );
  assert.deepEqual(normalized, ["数息", "安那般那"]);
  const terms = buildSemanticSearchTerms("心里很乱时怎样安定自己", normalized);
  assert(terms.includes("数息"));
  assert(terms.includes("安那般那"));
});

test("多个数据库候选集合按 id 去重并保留较高分", () => {
  const merged = mergeCandidateSets([
    [{ id: "a", db_score: 0.2 }],
    [{ id: "a", db_score: 0.8 }, { id: "b", db_score: 0.3 }],
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((row) => row.id === "a").db_score, 0.8);
  assert.equal(merged.find((row) => row.id === "a").term_hits, 2);
  assert.equal(merged.find((row) => row.id === "b").term_hits, 1);
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

test("语义精排能召回与问题没有原词重合的相关修持法门", () => {
  const rows = [
    { id: "noise", work: "历史的经验", chapter: "用人", content: "历史人物与政治经验。", db_score: 0.9 },
    { id: "semantic-hit", work: "定慧初修", chapter: "安般法门", content: "初学可以从数息入手，观察出入息而使心念渐定。", db_score: 0.8 },
  ];
  const ranked = rankCandidates(
    rows,
    "心里很乱时怎样安定自己",
    "semantic",
    2,
    0,
    ["数息", "安那般那", "出入息"],
  );
  assert.equal(ranked[0].row.id, "semantic-hit");
  assert(ranked[0].score > ranked[1].score);
});

test("语义结果优先覆盖不同章节，减少相邻重复片段", () => {
  const rows = [
    { id: "a1", work: "定慧初修", chapter: "安般法门", content: "数息与出入息。", db_score: 0.9, term_hits: 2 },
    { id: "a2", work: "定慧初修", chapter: "安般法门", content: "继续说明数息。", db_score: 0.88, term_hits: 1 },
    { id: "b1", work: "静坐修道与长生不老", chapter: "静坐", content: "静坐摄心。", db_score: 0.75, term_hits: 1 },
  ];
  const ranked = rankCandidates(rows, "心静不下来", "semantic", 2, 0, ["数息", "静坐", "摄心"]);
  assert.deepEqual(new Set(ranked.map(({ row }) => row.id)), new Set(["a1", "b1"]));
});
