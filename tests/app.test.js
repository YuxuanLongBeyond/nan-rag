const test = require("node:test");
const assert = require("node:assert/strict");

global.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};

const {
  state,
  tokenize,
  parseAndBuildIndex,
  searchExact,
  searchFuzzy,
  selectDiverseResults,
  renderAIText,
  makeContextualSnippet,
  parseSemanticTerms,
  expandSemanticQuery,
  searchRemote,
} = require("../app.js");

function useIndex(items) {
  state.index = parseAndBuildIndex(JSON.stringify(items));
}

test("中文问题会去掉问句套话并生成 2–4 字检索词", () => {
  const tokens = tokenize("南怀瑾如何理解安那般那？");
  assert(tokens.includes("安那般那"));
  assert(tokens.includes("安那"));
  assert(tokens.includes("般那"));
  assert(!tokens.includes("如何"));
});

test("模糊检索可从自然语言问题召回核心术语", () => {
  useIndex([
    { id: "noise", w: "论语别裁", c: "前言", n: 20, p: "先生讲人生修养与文化。" },
    { id: "hit", w: "定慧初修", c: "安般法门", n: 40, p: "安那般那是修习出入息的重要法门。" },
    { id: "other", w: "历史的经验", c: "用人", n: 20, p: "如何理解历史人物。" },
  ]);
  const results = searchFuzzy("南怀瑾如何理解安那般那？", 3, 0);
  assert.equal(results[0].chunk.id, "hit");
});

test("语义扩展只接受短文本数组并去重", () => {
  const terms = parseSemanticTerms(
    JSON.stringify({ terms: ["数息", "数息", "安那般那", "<script>", "心里很乱"] }),
    "心里很乱时怎么办",
  );
  assert.deepEqual(terms, ["数息", "安那般那", "script"]);
});

test("语义模式用浏览器 Key 直连 DeepSeek，但站内搜索请求不携带 Key", async () => {
  const previousFetch = global.fetch;
  state.apiKey = "sk-only-in-browser";
  state.searchMode = "semantic";
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (String(url).includes("deepseek.com")) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"terms":["数息","安那般那"]}' } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const terms = await expandSemanticQuery("脑子停不下来怎么办");
    await searchRemote("脑子停不下来怎么办", 8, 0.08, terms);
    assert.deepEqual(terms, ["数息", "安那般那"]);
    assert.equal(calls[0].options.headers.Authorization, "Bearer sk-only-in-browser");
    const siteBody = JSON.parse(calls[1].options.body);
    assert.deepEqual(siteBody.semanticTerms, terms);
    assert(!JSON.stringify(calls[1]).includes("sk-only-in-browser"));
  } finally {
    global.fetch = previousFetch;
    state.apiKey = "";
    state.searchMode = "fuzzy";
  }
});

test("精确检索覆盖旧版 60 字预览以后的正文", () => {
  useIndex([
    {
      id: "late-hit",
      w: "论语别裁",
      c: "前言",
      n: 220,
      p: "甲".repeat(180) + "亦有深刻体认" + "乙".repeat(20),
    },
  ]);
  const results = searchExact("亦有深刻体认", 5, 0);
  assert.equal(results[0].chunk.id, "late-hit");
});

test("结果默认限制同一章节占位，减少相邻重复片段", () => {
  const scored = [
    ["a1", "甲", "第一章", 0.9],
    ["a2", "甲", "第一章", 0.8],
    ["a3", "甲", "第一章", 0.7],
    ["b1", "乙", "第二章", 0.6],
  ].map(([id, w, c, score]) => ({ chunk: { id, w, c }, score }));
  const results = selectDiverseResults(scored, 3, 0);
  assert.deepEqual(results.map((r) => r.chunk.id), ["a1", "a2", "b1"]);
});

test("AI 最终输出会转义 HTML，同时保留引用跳转", () => {
  const html = renderAIText('<img src=x onerror="alert(1)"> [2]');
  assert(!html.includes("<img"));
  assert(html.includes("&lt;img"));
  assert(html.includes('data-cite="2"'));
});

test("结果摘要会定位到正文后部的命中词", () => {
  const text = "甲".repeat(360) + "安那般那" + "乙".repeat(100);
  const snippet = makeContextualSnippet(text, "什么是安那般那？", 120);
  assert(snippet.includes("安那般那"));
  assert(snippet.startsWith("..."));
});
