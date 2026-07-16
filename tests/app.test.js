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
  expandSemanticQueryLocally,
  expandSemanticQuery,
  searchRemote,
  fetchChunkContext,
  buildFollowUpRetrievalQuery,
  buildConversationMessages,
  snapshotResults,
  safeExternalUrl,
  trimConversationHistory,
  resetConversationState,
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

test("没有 API Key 时也能把常见日常说法映射为原著术语", async () => {
  state.apiKey = "";
  const terms = expandSemanticQueryLocally("晚上翻来覆去睡不着，脑子也停不下来");
  assert(terms.includes("不寐"));
  assert(terms.includes("数息"));
  assert(terms.includes("散乱"));
  assert.deepEqual(await expandSemanticQuery("晚上睡不着怎么办"), [
    "不寐", "数息", "安那般那", "出入息", "静坐", "止观",
  ]);
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
    assert.deepEqual(terms.slice(0, 2), ["数息", "安那般那"]);
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

test("上下文请求只发送片段编号与翻页参数，不携带浏览器 API Key", async () => {
  const previousFetch = global.fetch;
  state.apiKey = "sk-browser-only";
  state.contextCache.clear();
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ before: [], after: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await fetchChunkContext("chunk-1", "after", 2);
    assert.equal(request.url, "/api/context");
    assert.deepEqual(JSON.parse(request.options.body), {
      id: "chunk-1",
      direction: "after",
      limit: 2,
    });
    assert(!JSON.stringify(request).includes("sk-browser-only"));
  } finally {
    global.fetch = previousFetch;
    state.apiKey = "";
    state.contextCache.clear();
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

test("多轮 AI 引用包含唯一轮次，旧式编号默认绑定当前轮", () => {
  const html = renderAIText("前轮 [T1-2]，本轮 [3]", 4);
  assert(html.includes('data-turn="1" data-cite="2"'));
  assert(html.includes('data-turn="4" data-cite="3"'));
  assert(html.includes("[T1-2]"));
});

test("指代型追问继承上一轮检索主题，独立问题不会混入旧主题", () => {
  const conversation = [{
    role: "user",
    content: "失眠时怎样通过数息静心",
    retrievalQuery: "失眠 数息 安那般那",
  }];
  assert.equal(
    buildFollowUpRetrievalQuery("那具体怎么做？", conversation),
    "失眠 数息 安那般那；追问：那具体怎么做？",
  );
  assert.equal(
    buildFollowUpRetrievalQuery("南怀瑾怎样讲家庭教育？", conversation),
    "南怀瑾怎样讲家庭教育？",
  );
});

test("每轮提示词使用不重复的引用编号并保留历史证据", () => {
  const result = {
    chunk: { id: "a", w: "定慧初修", c: "数息", n: 20, p: "数息可以摄心。" },
    text: "数息可以摄心。",
    sourceUrl: "https://example.com/a",
    score: 0.8,
  };
  const history = [
    { role: "user", turnId: 1, prompt: "问题：失眠\n资料片段：\n[T1-1] 旧证据" },
    { role: "assistant", turnId: 1, content: "可参考 [T1-1]。" },
  ];
  const { messages, currentPrompt } = buildConversationMessages(
    "具体如何数息",
    [result],
    2,
    history,
  );
  assert(messages.some((message) => message.content.includes("[T1-1] 旧证据")));
  assert(currentPrompt.includes("[T2-1] 《定慧初修》数息"));
});

test("多轮提示词保留全部历史证据，不用裁剪换取速度", () => {
  const history = [];
  for (let turnId = 1; turnId <= 4; turnId += 1) {
    history.push({
      role: "user",
      turnId,
      prompt: `问题：第${turnId}轮\n资料片段：\n[T${turnId}-1] 完整历史证据${turnId}`,
    });
    history.push({ role: "assistant", turnId, content: `回答${turnId} [T${turnId}-1]` });
  }
  const { messages } = buildConversationMessages("继续", [], 5, history);
  for (let turnId = 1; turnId <= 4; turnId += 1) {
    assert(messages.some((message) =>
      message.content.includes(`[T${turnId}-1] 完整历史证据${turnId}`)));
  }
});

test("重新开始会清空检索状态并把引用轮次重置为一", () => {
  state.conversation = [{ role: "assistant", turnId: 7, content: "旧回答" }];
  state.nextTurnId = 8;
  state.lastResults = [{ id: "old" }];
  state.lastPrompt = "旧提示词";
  state.lastSemanticTerms = ["旧概念"];
  state.lastSearchMeta = { vectorMode: "neighbors" };
  state.searchMode = "exact";
  resetConversationState();
  assert.deepEqual(state.conversation, []);
  assert.equal(state.nextTurnId, 1);
  assert.deepEqual(state.lastResults, []);
  assert.equal(state.lastPrompt, "");
  assert.deepEqual(state.lastSemanticTerms, []);
  assert.equal(state.lastSearchMeta, null);
  assert.equal(state.searchMode, "semantic");
});

test("对话结果快照保存正文，且空来源不会被解析成当前网页", () => {
  const snapshots = snapshotResults([{
    chunk: { id: "a", w: "甲", c: "乙", n: 12, p: "预览" },
    text: "完整正文",
    sourceUrl: "",
    score: 0.7,
  }]);
  assert.equal(snapshots[0].text, "完整正文");
  assert.equal(safeExternalUrl(""), "");
});

test("超出上限时按完整轮次清理对话，不留下错配的问答", () => {
  state.conversation = [];
  for (let turnId = 1; turnId <= 11; turnId += 1) {
    state.conversation.push({ role: "user", turnId, content: `问题${turnId}` });
    state.conversation.push({ role: "assistant", turnId, content: `回答${turnId}` });
  }
  trimConversationHistory();
  assert.equal(state.conversation.length, 20);
  assert.equal(state.conversation[0].turnId, 2);
  assert.deepEqual(
    [...new Set(state.conversation.map((turn) => turn.turnId))],
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  state.conversation = [];
});

test("结果摘要会定位到正文后部的命中词", () => {
  const text = "甲".repeat(360) + "安那般那" + "乙".repeat(100);
  const snippet = makeContextualSnippet(text, "什么是安那般那？", 120);
  assert(snippet.includes("安那般那"));
  assert(snippet.startsWith("..."));
});
