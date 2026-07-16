/**
 * 南怀瑾著作 RAG 检索系统
 *
 * Vercel 前端 + Postgres 服务端检索 + DeepSeek AI 回答。
 * 浏览器只接收命中片段；GitHub Pages / 本地仍可使用静态降级模式。
 */

// ── 常量 ──────────────────────────────────────────
const CORPUS_DIR = "corpus/";
const INDEX_URL = "search_index.json";
const INDEX_VERSION_URL = "index_version.json";
const MANIFEST_URL = "works_manifest.json";
const EMBEDDINGS_URL = "embeddings.bin";
const SEARCH_API_URL = "/api/search";
const CONTEXT_API_URL = "/api/context";
const HEALTH_API_URL = "/api/health";
const DB_NAME = "nan-rag-corpus";
const DB_VERSION = 3;  // 升级：新增 embeddings store
const STORE_WORKS = "works";
const STORE_META = "meta";
const STORE_INDEX = "indexMeta";
const STORE_EMBEDDINGS = "embeddings";
const COPYRIGHT_KEY = "nan-copyright-accepted";
const API_KEY_STORAGE = "nan-deepseek-key";
const API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const CONVERSATION_MAX_TURNS = 10;
const MAX_RESULTS_PER_SECTION = 2;
const SEMANTIC_CACHE_LIMIT = 30;
const FOLLOW_UP_REFERENCE_PATTERN =
  /^(那|那么|这个|那个|这些|那些|它|它们|其|上述|上面|刚才|前面|其中|对此|这种|这点|具体|继续|再讲|再说)|第[一二三四五六七八九十\d]+(个|点|段)|还(有|能).{0,8}(吗|呢|么)?$/;
const QUERY_STOPWORDS = new Set([
  "南怀瑾", "南先生", "南老师", "先生", "老师", "如何", "怎么",
  "怎样", "什么", "什么是", "是什么", "为何", "为什么", "认为",
  "看待", "理解", "解释", "讲过", "说过", "请问", "一下",
]);
const LOCAL_SEMANTIC_RULES = [
  {
    patterns: /睡不着|失眠|不眠|翻来覆去|难以入睡|夜里.*醒/,
    terms: ["不寐", "数息", "安那般那", "出入息", "静坐", "止观"],
  },
  {
    patterns: /心里很乱|心烦|烦乱|焦虑|脑子.*停不下来|胡思乱想|念头.*多|不能静/,
    terms: ["散乱", "妄念", "摄心", "观心", "数息", "止观"],
  },
  {
    patterns: /发脾气|脾气|愤怒|生气|恨|冲突|控制不住.*情绪/,
    terms: ["嗔心", "瞋恨", "忍辱", "观心", "习气", "烦恼"],
  },
  {
    patterns: /去世|死亡|死后|临终|生命终点|人死|往生/,
    terms: ["中阴", "投生", "轮回", "六道", "临终", "生死"],
  },
  {
    patterns: /打坐|静坐|腿麻|腿痛|盘腿|坐禅/,
    terms: ["静坐", "坐禅", "七支坐法", "气脉", "腿发麻", "禅定"],
  },
  {
    patterns: /呼吸|数呼吸|调息|气息/,
    terms: ["数息", "安那般那", "出入息", "安般", "调息", "十六特胜"],
  },
  {
    patterns: /恐惧|害怕|担心|没有安全感|胆怯/,
    terms: ["恐惧", "无畏", "观心", "妄念", "定力", "安心"],
  },
  {
    patterns: /痛苦|烦恼|压力|放不下|执着|想不开/,
    terms: ["烦恼", "执著", "放下", "观心", "般若", "解脱"],
  },
  {
    patterns: /命运|运气|前世|因果|报应/,
    terms: ["因果", "业力", "果报", "宿业", "命运", "轮回"],
  },
  {
    patterns: /教育孩子|孩子.*教育|亲子|子女|家庭教育/,
    terms: ["家庭教育", "胎教", "孝道", "习气", "人格教育", "身教"],
  },
];

// ── 全局状态 ──────────────────────────────────────
const state = {
  // 搜索索引（从 search_index.json 加载）
  index: [],            // [{id, w, c, n, p, _searchText}, ...]

  // 作品清单
  manifest: {},         // { "论语别裁": {file, chunks, size}, ... }

  // 全文缓存: Map<workName, Map<chunkId, {t, c, u}>>
  textCache: new Map(),

  // 正在加载的 work（防止重复请求）
  pendingWorks: new Map(),

  // 检索结果
  lastResults: [],
  lastPrompt: "",
  searchSeq: 0,
  indexVersion: null,

  // "remote"：Vercel + Postgres；"local"：旧静态索引降级模式
  backendMode: "pending",
  backendMeta: null,
  lastSearchMeta: null,

  // 加载状态
  loading: { stage: "idle", current: 0, total: 0 },

  // API
  apiKey: localStorage.getItem(API_KEY_STORAGE) || "",

  // 搜索模式: "fuzzy" | "exact" | "semantic"
  searchMode: "semantic",
  lastSemanticTerms: [],
  lastSemanticSource: "",
  semanticCache: new Map(),
  contextCache: new Map(),
  searchController: null,

  // 语义向量（从 embeddings.bin 加载）
  embeddings: null,     // { dim, buffer: ArrayBuffer, min, max, version }

  // 多轮对话
  conversation: [],     // [{ role, turnId, content, prompt?, results? }, ...]
  nextTurnId: 1,
  answerSeq: 0,
  answerController: null,
};

// ── DOM 引用 ──────────────────────────────────────
let els = {};

function bindEls() {
  els = {
    // 版权弹窗
    copyrightGate: document.getElementById("copyrightGate"),
    acceptGate: document.getElementById("acceptGate"),

    // 加载
    loadingOverlay: document.getElementById("loadingOverlay"),
    loadingText: document.getElementById("loadingText"),
    loadingBar: document.getElementById("loadingBar"),
    loadingHint: document.getElementById("loadingHint"),
    retryLoading: document.getElementById("retryLoading"),

    // 侧边栏
    libraryStats: document.getElementById("libraryStats"),
    libraryList: document.getElementById("libraryList"),

    // API 设置
    apiKeyInput: document.getElementById("apiKeyInput"),
    saveApiKey: document.getElementById("saveApiKey"),
    apiStatus: document.getElementById("apiStatus"),
    apiSettings: document.getElementById("apiSettings"),

    // 搜索
    queryInput: document.getElementById("queryInput"),
    searchButton: document.getElementById("searchButton"),
    topK: document.getElementById("topK"),
    minScore: document.getElementById("minScore"),
    strictMode: document.getElementById("strictMode"),
    exactSearch: document.getElementById("exactSearch"),
    modeHelp: document.getElementById("modeHelp"),
    searchInsight: document.getElementById("searchInsight"),
    queryExamples: document.querySelectorAll("[data-query]"),
    libraryDetails: document.getElementById("libraryDetails"),

    // AI 回答
    aiAnswerBtn: document.getElementById("aiAnswerBtn"),
    answerStatus: document.getElementById("answerStatus"),
    answerBox: document.getElementById("answerBox"),
    copyPrompt: document.getElementById("copyPrompt"),
    newChatBtn: document.getElementById("newChatBtn"),

    // 追问输入栏
    quickAskBar: document.getElementById("quickAskBar"),
    quickAskInput: document.getElementById("quickAskInput"),
    quickAskBtn: document.getElementById("quickAskBtn"),

    // 结果
    retrievalResultsWrap: document.getElementById("retrievalResultsWrap"),
    resultCount: document.getElementById("resultCount"),
    results: document.getElementById("results"),

    // 模板
    docTemplate: document.getElementById("docTemplate"),
    resultTemplate: document.getElementById("resultTemplate"),
  };
}

// ── 工具函数 ──────────────────────────────────────
function tokenize(text) {
  const lower = String(text).normalize("NFKC").toLowerCase();
  const latin = lower.match(/[a-z0-9]+/g) || [];
  const searchable = lower.replace(
    /南怀瑾|南先生|南老师|先生|老师|什么是|是什么|为什么|如何|怎么|怎样|为何|认为|看待|理解|解释|讲过|说过|请问|一下/g,
    " ",
  );
  const runs = searchable.match(/[㐀-鿿]+/g) || [];
  const chinese = [];

  for (const run of runs) {
    if (run.length === 1) {
      chinese.push(run);
      continue;
    }
    if (run.length <= 10 && !QUERY_STOPWORDS.has(run)) chinese.push(run);
    for (let n = 2; n <= Math.min(4, run.length); n += 1) {
      for (let i = 0; i <= run.length - n; i += 1) {
        const token = run.slice(i, i + n);
        if (!QUERY_STOPWORDS.has(token)) chinese.push(token);
      }
    }
  }

  return [...new Set([...latin, ...chinese])];
}

function makeGrams(text) {
  const clean = String(text).normalize("NFKC").toLowerCase()
    .replace(/[^\u3400-\u9fffa-z0-9]+/g, "");
  const grams = new Map();
  for (let n = 2; n <= 4; n += 1) {
    for (let i = 0; i <= clean.length - n; i += 1) {
      const gram = clean.slice(i, i + n);
      if (!/[\u3400-\u9fffa-z0-9]/.test(gram)) continue;
      grams.set(gram, (grams.get(gram) || 0) + 1);
    }
  }
  return grams;
}

function cosineLike(queryGrams, chunkGrams) {
  let overlap = 0, querySize = 0, chunkSize = 0;
  queryGrams.forEach((count, gram) => {
    querySize += count * count;
    overlap += Math.min(count, chunkGrams.get(gram) || 0);
  });
  chunkGrams.forEach((count) => { chunkSize += count * count; });
  if (!querySize || !chunkSize) return 0;
  return overlap / Math.sqrt(querySize * chunkSize);
}

function estimateTokenDF(tokens) {
  const N = state.index.length;
  const sampleTarget = Math.min(10000, N);
  const step = Math.max(1, Math.floor(N / Math.max(1, sampleTarget)));
  const sampled = Math.ceil(N / step);
  const tokenDF = new Map();

  for (const token of tokens) {
    if (token.length < 2) continue;
    let df = 0;
    for (let i = 0; i < N; i += step) {
      if (state.index[i]._searchText.includes(token)) df += 1;
    }
    const idf = Math.log((sampled + 1) / (df + 0.5)) + 1;
    tokenDF.set(token, Math.max(0.5, Math.min(5, idf)));
  }
  return tokenDF;
}

function tokenWeight(token, tokenDF) {
  const lengthWeight = Math.min(2, Math.max(1, token.length / 2));
  return lengthWeight * (tokenDF.get(token) || 0.5);
}

function keywordCoverage(text, tokens, tokenDF) {
  let matched = 0;
  let total = 0;
  for (const token of tokens) {
    if (token.length < 2) continue;
    const weight = tokenWeight(token, tokenDF);
    total += weight;
    if (text.includes(token)) matched += weight;
  }
  return total > 0 ? matched / total : 0;
}

function longestQueryToken(tokens) {
  return tokens.reduce((longest, token) =>
    token.length > longest.length ? token : longest, "");
}

function selectDiverseResults(scored, topK, minScore) {
  const eligible = scored
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score);
  const selected = [];
  const deferred = [];
  const sectionCounts = new Map();

  for (const result of eligible) {
    const section = `${result.chunk.w}\u0000${result.chunk.c}`;
    const count = sectionCounts.get(section) || 0;
    if (count < MAX_RESULTS_PER_SECTION && selected.length < topK) {
      selected.push(result);
      sectionCounts.set(section, count + 1);
    } else {
      deferred.push(result);
    }
  }
  for (const result of deferred) {
    if (selected.length >= topK) break;
    selected.push(result);
  }
  return selected;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderAIText(text, defaultTurnId = null) {
  const fallbackTurn = Number.isInteger(defaultTurnId) && defaultTurnId > 0
    ? ` data-turn="${defaultTurnId}"`
    : "";
  return escapeHtml(text)
    .replace(/\n/g, "<br>")
    .replace(
      /\[T(\d+)-(\d+)\]/gi,
      '<span class="cite-link" data-turn="$1" data-cite="$2"><sup class="cite">[T$1-$2]</sup></span>',
    )
    .replace(
      /\[(\d+)\]/g,
      `<span class="cite-link"${fallbackTurn} data-cite="$1"><sup class="cite">[$1]</sup></span>`,
    );
}

function getLastUserTurn(conversation = state.conversation) {
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    if (conversation[i].role === "user") return conversation[i];
  }
  return null;
}

/**
 * “那具体怎么做”一类追问缺少独立检索主题。只在检测到指代/承接表达时，
 * 才继承上一轮检索问题，避免用户切换话题时引入旧主题噪声。
 */
function buildFollowUpRetrievalQuery(query, conversation = state.conversation) {
  const current = String(query || "").trim();
  const normalized = current.normalize("NFKC");
  if (!current || !FOLLOW_UP_REFERENCE_PATTERN.test(normalized)) return current;
  const previousTurn = getLastUserTurn(conversation);
  const previous = String(
    previousTurn?.retrievalQuery || previousTurn?.content || "",
  ).trim();
  if (!previous || previous === current) return current;
  return `${previous.slice(0, 180)}；追问：${current}`;
}

function snapshotResults(results) {
  return results.map((result) => ({
    id: result.chunk.id,
    work: result.chunk.w,
    chapter: result.chunk.c,
    charCount: result.chunk.n,
    preview: result.chunk.p || "",
    text: result.text || result.chunk.p || "",
    sourceUrl: result.sourceUrl || "",
    score: Number(result.score) || 0,
  }));
}

function safeExternalUrl(value) {
  try {
    const input = String(value || "").trim();
    if (!input) return "";
    const url = new URL(input, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

async function fetchChunkContext(id, direction = "around", limit = 2) {
  const safeDirection = ["around", "before", "after"].includes(direction)
    ? direction
    : "around";
  const safeLimit = Math.max(1, Math.min(4, Math.trunc(Number(limit) || 2)));
  const cacheKey = `${id}:${safeDirection}:${safeLimit}`;
  if (state.contextCache.has(cacheKey)) return state.contextCache.get(cacheKey);

  const request = fetch(CONTEXT_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Copyright-Accepted": "1",
    },
    body: JSON.stringify({ id, direction: safeDirection, limit: safeLimit }),
  }).then(async (response) => {
    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (!response.ok) {
      throw new Error(data?.error || `上下文接口返回 HTTP ${response.status}`);
    }
    return data;
  }).catch((error) => {
    state.contextCache.delete(cacheKey);
    throw error;
  });
  state.contextCache.set(cacheKey, request);
  return request;
}

function createContextChunkElement(chunk, isCurrent = false) {
  const article = document.createElement("article");
  article.className = `context-chunk${isCurrent ? " is-current" : ""}`;
  article.dataset.chunkId = chunk.id;

  const label = document.createElement("div");
  label.className = "context-chunk-label";
  label.textContent = isCurrent ? "当前引用" : "相邻原文";
  const text = document.createElement("p");
  text.textContent = chunk.text || "";
  article.append(label, text);
  return article;
}

/**
 * 为没有可访问来源链接的命中片段提供站内上下文阅读器。
 * 初次展开读取前后各两段，之后可沿同一作品、同一章节继续翻阅。
 */
function attachContextBrowser(button, current, elementsToHide = []) {
  if (!button || !current?.id || state.backendMode !== "remote") return;
  button.hidden = false;

  const panel = document.createElement("section");
  panel.className = "context-browser";
  panel.hidden = true;
  button.closest("article")?.appendChild(panel);

  let initialized = false;
  let loading = false;
  let before = [];
  let after = [];
  let hasBefore = false;
  let hasAfter = false;

  const render = () => {
    panel.replaceChildren();
    const head = document.createElement("div");
    head.className = "context-browser-head";
    const title = document.createElement("strong");
    title.textContent = "同章节上下文";
    const location = document.createElement("span");
    location.textContent = `《${current.work}》${current.chapter || ""}`;
    head.append(title, location);

    const list = document.createElement("div");
    list.className = "context-chunk-list";
    before.forEach((chunk) => list.appendChild(createContextChunkElement(chunk)));
    list.appendChild(createContextChunkElement(current, true));
    after.forEach((chunk) => list.appendChild(createContextChunkElement(chunk)));

    const nav = document.createElement("div");
    nav.className = "context-browser-nav";
    const previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = hasBefore ? "继续看前文" : "已到本章节开头";
    previous.disabled = !hasBefore || loading;
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = hasAfter ? "继续看后文" : "已到本章节末尾";
    next.disabled = !hasAfter || loading;

    previous.addEventListener("click", async () => {
      if (loading || !hasBefore) return;
      loading = true;
      previous.disabled = true;
      previous.textContent = "正在加载...";
      try {
        const anchor = before[0]?.id || current.id;
        const data = await fetchChunkContext(anchor, "before", 2);
        before = [...data.before, ...before];
        hasBefore = Boolean(data.hasBefore);
        loading = false;
        render();
      } catch (error) {
        loading = false;
        showToast(error.message);
        render();
      }
    });
    next.addEventListener("click", async () => {
      if (loading || !hasAfter) return;
      loading = true;
      next.disabled = true;
      next.textContent = "正在加载...";
      try {
        const anchor = after.at(-1)?.id || current.id;
        const data = await fetchChunkContext(anchor, "after", 2);
        after = [...after, ...data.after];
        hasAfter = Boolean(data.hasAfter);
        loading = false;
        render();
      } catch (error) {
        loading = false;
        showToast(error.message);
        render();
      }
    });
    nav.append(previous, next);
    panel.append(head, list, nav);
  };

  const open = async () => {
    panel.hidden = false;
    elementsToHide.forEach((element) => { if (element) element.hidden = true; });
    button.textContent = "收起上下文";
    if (initialized || loading) return;
    loading = true;
    panel.innerHTML = '<p class="context-loading">正在加载前后原文...</p>';
    try {
      const data = await fetchChunkContext(current.id, "around", 2);
      before = data.before || [];
      after = data.after || [];
      hasBefore = Boolean(data.hasBefore);
      hasAfter = Boolean(data.hasAfter);
      initialized = true;
      loading = false;
      render();
    } catch (error) {
      loading = false;
      panel.innerHTML = `<p class="context-error">${escapeHtml(error.message)}</p>`;
    }
  };

  button.addEventListener("click", () => {
    if (!panel.hidden) {
      panel.hidden = true;
      elementsToHide.forEach((element) => { if (element) element.hidden = false; });
      button.textContent = "展开上下文";
      return;
    }
    open();
  });
}

function highlight(text, query) {
  const candidates = tokenize(query)
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);
  const tokens = [];
  for (const token of candidates) {
    if (!tokens.some((longer) => longer.includes(token))) tokens.push(token);
    if (tokens.length >= 12) break;
  }
  if (tokens.length === 0) return escapeHtml(text);

  const pattern = new RegExp(tokens.map(escapeRegExp).join("|"), "gi");
  let out = "";
  let cursor = 0;
  for (const match of String(text).matchAll(pattern)) {
    out += escapeHtml(String(text).slice(cursor, match.index));
    out += `<mark>${escapeHtml(match[0])}</mark>`;
    cursor = match.index + match[0].length;
  }
  out += escapeHtml(String(text).slice(cursor));
  return out;
}

function makeContextualSnippet(text, query, maxLength = 300) {
  const compact = String(text).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;

  const tokens = tokenize(query)
    .filter((token) => token.length >= 2)
    .sort((a, b) => b.length - a.length);
  let matchAt = -1;
  for (const token of tokens) {
    matchAt = compact.toLowerCase().indexOf(token);
    if (matchAt !== -1) break;
  }

  const start = matchAt === -1
    ? 0
    : Math.max(0, Math.min(matchAt - 70, compact.length - maxLength));
  const excerpt = compact.slice(start, start + maxLength);
  return `${start > 0 ? "..." : ""}${excerpt}${start + maxLength < compact.length ? "..." : ""}`;
}

// ── IndexedDB ─────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_WORKS)) {
        db.createObjectStore(STORE_WORKS, { keyPath: "work" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_INDEX)) {
        db.createObjectStore(STORE_INDEX, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_EMBEDDINGS)) {
        db.createObjectStore(STORE_EMBEDDINGS, { keyPath: "key" });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getCachedWork(db, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_WORKS, "readonly");
    const req = tx.objectStore(STORE_WORKS).get(work);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putCachedWork(db, work, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_WORKS, "readwrite");
    tx.objectStore(STORE_WORKS).put({
      work,
      ...data,
      version: state.indexVersion,
      cachedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 从 IndexedDB 读取缓存的搜索索引（原始 JSON 文本）。
 * 返回 { version, raw } 或 null。
 */
async function getCachedIndex(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_INDEX, "readonly");
    const req = tx.objectStore(STORE_INDEX).get("searchIndex");
    req.onsuccess = () => {
      const record = req.result;
      if (record && record.raw && record.version) {
        resolve({ version: record.version, raw: record.raw, count: record.count });
      } else {
        resolve(null);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * 将搜索索引的原始 JSON 文本存入 IndexedDB。
 */
async function putCachedIndex(db, version, raw, count) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_INDEX, "readwrite");
    tx.objectStore(STORE_INDEX).put({
      key: "searchIndex",
      version,
      raw,
      count,
      cachedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 解析原始 JSON 并构建 _searchText 字段。
 * 用 setTimeout 分段执行，避免阻塞 UI 线程。
 */
function parseAndBuildIndex(rawText) {
  const arr = JSON.parse(rawText);
  for (const item of arr) {
    item._searchText = `${item.w} ${item.c} ${item.p}`.toLowerCase();
  }
  return arr;
}

/**
 * 从 IndexedDB 读取缓存的 embeddings。
 */
async function getCachedEmbeddings(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_EMBEDDINGS, "readonly");
    const req = tx.objectStore(STORE_EMBEDDINGS).get("embeddings");
    req.onsuccess = () => {
      const record = req.result;
      if (record && record.buffer && record.version) {
        resolve(record);
      } else {
        resolve(null);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * 将 embeddings 存入 IndexedDB。
 */
async function putCachedEmbeddings(db, version, dim, buffer, fmin, fmax) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_EMBEDDINGS, "readwrite");
    tx.objectStore(STORE_EMBEDDINGS).put({
      key: "embeddings",
      version,
      dim,
      buffer,
      min: fmin,
      max: fmax,
      cachedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── 数据加载 ──────────────────────────────────────
/**
 * 从网络下载搜索索引（带进度条），完成后缓存到 IndexedDB。
 * 返回解析好的 index 数组。
 */
async function loadSearchIndexFromNetwork(version) {
  els.loadingText.textContent = "正在下载搜索索引...";
  els.loadingBar.style.width = "10%";

  const resp = await fetch(INDEX_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${INDEX_URL}`);

  const total = parseInt(resp.headers.get("content-length") || "0", 10);
  let loaded = 0;
  const reader = resp.body.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total) {
      const pct = 10 + Math.round((loaded / total) * 50);
      els.loadingBar.style.width = pct + "%";
      els.loadingText.textContent =
        `正在下载搜索索引... ${(loaded / 1024 / 1024).toFixed(1)} MB`;
    }
  }

  // 合并原始文本
  els.loadingText.textContent = "正在解析搜索索引...";
  els.loadingBar.style.width = "70%";
  const blob = new Blob(chunks);
  const rawText = await blob.text();

  // 解析并构建 _searchText
  els.loadingText.textContent = "正在构建搜索索引...";
  els.loadingBar.style.width = "80%";
  const index = parseAndBuildIndex(rawText);
  els.loadingBar.style.width = "90%";

  // 缓存到 IndexedDB（异步，不阻塞）
  try {
    const db = await openDB();
    await putCachedIndex(db, version, rawText, index.length);
    db.close();
    console.log(`索引已缓存到 IndexedDB (v${version}, ${index.length.toLocaleString()} 条)`);
  } catch (e) {
    console.warn("索引缓存到 IndexedDB 失败:", e);
  }

  return index;
}

/**
 * 从 IndexedDB 加载缓存的搜索索引。
 * 返回解析好的 index 数组，或 null。
 */
async function loadSearchIndexFromCache() {
  try {
    const db = await openDB();
    const cached = await getCachedIndex(db);
    db.close();
    if (!cached) return null;
    state.indexVersion = cached.version;
    console.log(`从 IndexedDB 加载索引 (v${cached.version}, ${cached.count.toLocaleString()} 条)`);
    return parseAndBuildIndex(cached.raw);
  } catch (e) {
    console.warn("从 IndexedDB 加载索引失败:", e);
    return null;
  }
}

/**
 * 后台检查索引是否有更新，如有则更新缓存。
 */
async function checkForIndexUpdate(currentVersion) {
  try {
    const resp = await fetch(INDEX_VERSION_URL, { cache: "no-cache" });
    if (!resp.ok) return;
    const info = await resp.json();
    if (info.v && info.v !== currentVersion) {
      console.log(`索引有新版本: ${info.v}（当前: ${currentVersion}），后台更新中...`);
      await loadSearchIndexFromNetwork(info.v);
    }
  } catch (e) {
    // 静默失败
  }
}

/**
 * 从网络下载 embeddings.bin，缓存到 IndexedDB。
 */
async function loadEmbeddingsFromNetwork(version) {
  const resp = await fetch(EMBEDDINGS_URL);
  if (!resp.ok) {
    if (resp.status === 404) {
      console.log("embeddings.bin 不存在，语义搜索不可用");
      return null;
    }
    throw new Error(`HTTP ${resp.status}: ${EMBEDDINGS_URL}`);
  }

  const buffer = await resp.arrayBuffer();
  const view = new DataView(buffer);

  // 解析二进制格式: dim(4B uint32) + quantized(N×dim int8) + min(4B float32) + max(4B float32)
  if (buffer.byteLength < 12) {
    throw new Error("embeddings.bin 格式无效");
  }

  const dim = view.getUint32(0, true);  // little-endian
  const dataLen = buffer.byteLength - 12;
  const expectedLen = dim; // 每个 chunk dim 个 int8
  if (dataLen % expectedLen !== 0) {
    throw new Error(`embeddings.bin 数据长度不匹配: ${dataLen} 不能被 ${expectedLen} 整除`);
  }

  const fmin = view.getFloat32(buffer.byteLength - 8, true);
  const fmax = view.getFloat32(buffer.byteLength - 4, true);

  console.log(`加载 embeddings: ${dim} 维, ${dataLen / dim} 条, 范围 [${fmin.toFixed(4)}, ${fmax.toFixed(4)}]`);

  // 缓存到 IndexedDB
  try {
    const db = await openDB();
    await putCachedEmbeddings(db, version, dim, buffer, fmin, fmax);
    db.close();
  } catch (e) {
    console.warn("embeddings 缓存到 IndexedDB 失败:", e);
  }

  return { dim, buffer, min: fmin, max: fmax, version };
}

/**
 * 从 IndexedDB 加载缓存的 embeddings。
 */
async function loadEmbeddingsFromCache() {
  try {
    const db = await openDB();
    const cached = await getCachedEmbeddings(db);
    db.close();
    const expectedBytes = state.index.length * cached?.dim + 12;
    if (cached && cached.version === state.indexVersion &&
        cached.buffer.byteLength === expectedBytes) {
      console.log(`从 IndexedDB 加载 embeddings (v${cached.version}, ${cached.dim} 维)`);
      return {
        dim: cached.dim,
        buffer: cached.buffer,
        min: cached.min,
        max: cached.max,
        version: cached.version,
      };
    } else if (cached) {
      console.warn("忽略与当前索引版本不匹配的 embeddings 缓存");
    }
  } catch (e) {
    console.warn("从 IndexedDB 加载 embeddings 失败:", e);
  }
  return null;
}

/**
 * 检查是否有语义搜索所需的数据。
 */
function hasSemanticSearch() {
  return state.embeddings !== null &&
    state.embeddings.version === state.indexVersion &&
    state.embeddings.buffer.byteLength === state.index.length * state.embeddings.dim + 12;
}

/**
 * 按需加载 embeddings（用于用户切换到语义模式时）。
 * 返回 true 表示 embeddings 已可用。
 */
async function checkAndLoadEmbeddings() {
  if (hasSemanticSearch()) return true;

  // 尝试从 IndexedDB 加载
  const cached = await loadEmbeddingsFromCache();
  if (cached) {
    state.embeddings = cached;
    return true;
  }

  // 尝试从网络加载（需要 version 信息）
  try {
    const vResp = await fetch(INDEX_VERSION_URL, { cache: "no-cache" });
    if (vResp.ok) {
      const vInfo = await vResp.json();
      const embVersion = state.indexVersion || vInfo.v || "unknown";
      if (vInfo.v && state.indexVersion && vInfo.v !== state.indexVersion) {
        console.warn("服务器 embeddings 与当前缓存索引版本不同，暂不加载");
        return false;
      }
      const emb = await loadEmbeddingsFromNetwork(embVersion);
      if (emb) {
        state.embeddings = emb;
        return true;
      }
    }
  } catch (e) {
    console.warn("按需加载 embeddings 失败:", e);
  }

  return false;
}

async function loadManifest() {
  const resp = await fetch(MANIFEST_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${MANIFEST_URL}`);
  state.manifest = await resp.json();
}

function shouldAllowStaticFallback() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  const host = window.location.hostname;
  return params.get("local") === "1" ||
    window.location.protocol === "file:" ||
    host === "localhost" || host === "127.0.0.1" || host === "::1" ||
    host.endsWith(".github.io");
}

function isSearchReady() {
  return state.backendMode === "remote" || state.index.length > 0;
}

async function checkRemoteBackend() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(HEALTH_API_URL, {
      cache: "no-store",
      signal: controller.signal,
    });
    let info = null;
    try { info = await resp.json(); } catch { /* 非 API 静态站点 */ }
    if (!resp.ok || !info?.ready) {
      throw new Error(info?.error || `检索 API 返回 HTTP ${resp.status}`);
    }
    state.backendMode = "remote";
    state.backendMeta = info;
    state.indexVersion = info.version || null;
    return info;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("连接检索 API 超时，请稍后重试");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function searchRemote(
  query,
  topK,
  minScore,
  semanticTerms = [],
  mode = state.searchMode,
  signal,
) {
  const resp = await fetch(SEARCH_API_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Copyright-Accepted": "1",
    },
    body: JSON.stringify({
      query,
      mode,
      topK,
      minScore,
      semanticTerms,
    }),
  });
  let data = null;
  try { data = await resp.json(); } catch { /* handled below */ }
  if (!resp.ok) {
    throw new Error(data?.error || `检索 API 返回 HTTP ${resp.status}`);
  }
  const results = (data?.results || []).map((result) => ({
    chunk: {
      id: result.id,
      w: result.work,
      c: result.chapter,
      n: result.charCount,
      p: result.preview,
    },
    text: result.text || result.preview || "",
    sourceUrl: result.sourceUrl || "",
    score: Number(result.score) || 0,
  }));
  results.meta = data?.meta || null;
  return results;
}

function parseSemanticTerms(content, query) {
  let parsed;
  try {
    parsed = JSON.parse(String(content || ""));
  } catch {
    return [];
  }
  const values = Array.isArray(parsed) ? parsed : parsed?.terms;
  if (!Array.isArray(values)) return [];

  const normalizedQuery = String(query || "").normalize("NFKC").toLowerCase();
  const terms = [];
  for (const value of values) {
    const term = String(value || "")
      .normalize("NFKC")
      .replace(/[^\u3400-\u9fffa-zA-Z0-9\s-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (term.length < 2 || term.length > 18) continue;
    if (normalizedQuery.includes(term.toLowerCase()) || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length >= 8) break;
  }
  return terms;
}

/**
 * 常见日常说法到原著术语的轻量映射。它不代替模型理解，但能让没有 API Key
 * 的用户也直接使用基础语义检索，并在模型或网络失败时提供可靠降级。
 */
function expandSemanticQueryLocally(query) {
  const normalized = String(query || "").normalize("NFKC").toLowerCase();
  const terms = [];
  for (const rule of LOCAL_SEMANTIC_RULES) {
    if (!rule.patterns.test(normalized)) continue;
    for (const term of rule.terms) {
      if (!normalized.includes(term.toLowerCase()) && !terms.includes(term)) terms.push(term);
      if (terms.length >= 8) return terms;
    }
  }
  return terms;
}

/**
 * 用用户自己的 DeepSeek Key 把自然语言问题扩展为语料中可能出现的概念词。
 * Key 只从浏览器直连 DeepSeek，不经过本站服务端。
 */
async function expandSemanticQuery(query) {
  const cacheKey = String(query || "").normalize("NFKC").trim().toLowerCase();
  const cached = state.semanticCache.get(cacheKey);
  if (cached) {
    state.lastSemanticSource = cached.source;
    return [...cached.terms];
  }

  const localTerms = expandSemanticQueryLocally(query);
  if (!state.apiKey) {
    state.lastSemanticSource = localTerms.length > 0 ? "local" : "fallback";
    return localTerms;
  }

  const prompt = [
    "请把用户的日常中文问题转换成适合检索南怀瑾著作原文的查询词。",
    "按相关性从高到低给出 6 至 8 个原文中可能实际出现的词。",
    "优先包含：核心概念、传统术语、同义表达、具体修持法门；避免宽泛词和无关联想。",
    "不要回答问题，不要解释，不要重复用户已经明确说出的词。",
    '必须输出 JSON，例如：{"terms":["数息","安那般那","出入息"]}',
    `用户问题：${query}`,
  ].join("\n");

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${state.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages: [
            { role: "system", content: "你是中文 RAG 查询扩展器，只输出合法 JSON。" },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          stream: false,
          temperature: 0,
          max_tokens: 180,
        }),
      });
      if (!resp.ok) {
        const details = await resp.text();
        throw new Error(`DeepSeek API ${resp.status}: ${details.slice(0, 120)}`);
      }
      const data = await resp.json();
      const aiTerms = parseSemanticTerms(data.choices?.[0]?.message?.content, query);
      if (aiTerms.length > 0) {
        const terms = [...new Set([...aiTerms, ...localTerms])].slice(0, 8);
        state.lastSemanticSource = "ai";
        state.semanticCache.set(cacheKey, { terms, source: "ai" });
        while (state.semanticCache.size > SEMANTIC_CACHE_LIMIT) {
          state.semanticCache.delete(state.semanticCache.keys().next().value);
        }
        return terms;
      }
      lastError = new Error("DeepSeek 未返回可用的语义扩展词");
    } catch (error) {
      lastError = controller.signal.aborted
        ? new Error("语义扩展请求超时，请稍后重试")
        : error;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (localTerms.length > 0) {
    state.lastSemanticSource = "local";
    return localTerms;
  }
  state.lastSemanticSource = "fallback";
  console.warn("AI 语义扩展失败，降级为增强模糊检索:", lastError);
  return [];
}

async function ensureResultTexts(results) {
  const missing = results.filter((result) => !result.text);
  if (missing.length === 0 || state.backendMode === "remote") return;
  const neededWorks = new Set(missing.map((result) => result.chunk.w));
  await Promise.all([...neededWorks].map((work) => loadCorpusForWork(work).catch(() => {})));
  for (const result of missing) {
    const entry = state.textCache.get(result.chunk.w)?.get(result.chunk.id);
    if (entry) {
      result.text = entry.t || "";
      result.sourceUrl = entry.u || "";
    }
  }
}

/**
 * 获取指定 work 的全文语料（从 IndexedDB 缓存或网络）。
 * 返回 Map<chunkId, {t: text, c: chapter_title, u: source_url}>
 */
async function loadCorpusForWork(work) {
  // 检查内存缓存
  if (state.textCache.has(work)) {
    return state.textCache.get(work);
  }

  // 防止重复请求
  if (state.pendingWorks.has(work)) {
    return state.pendingWorks.get(work);
  }

  const promise = (async () => {
    const info = state.manifest[work];
    if (!info) {
      console.warn(`作品 "${work}" 不在 manifest 中`);
      return new Map();
    }

    // 尝试 IndexedDB
    try {
      const db = await openDB();
      const cached = await getCachedWork(db, work);
      if (cached && cached.chunks && cached.version === state.indexVersion) {
        const m = new Map(Object.entries(cached.chunks));
        state.textCache.set(work, m);
        db.close();
        return m;
      }
      db.close();
    } catch (e) {
      console.warn("IndexedDB 读取失败:", e);
    }

    // 从网络加载
    const url = CORPUS_DIR + info.file.split("/").pop();
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
    const data = await resp.json();

    // data 格式: { chunkId: {t, c, u}, ... }
    const m = new Map(Object.entries(data));
    state.textCache.set(work, m);

    // 缓存到 IndexedDB
    try {
      const db = await openDB();
      await putCachedWork(db, work, { chunks: data });
      db.close();
    } catch (e) {
      console.warn("IndexedDB 写入失败:", e);
    }

    return m;
  })();

  state.pendingWorks.set(work, promise);
  try {
    return await promise;
  } finally {
    state.pendingWorks.delete(work);
  }
}

// ── 搜索 ──────────────────────────────────────────
/**
 * 精确全文检索：字面子串匹配。
 * 在 _searchText 中查找用户输入作为完整子串，按匹配位置和次数排名。
 */
function searchExact(query, topK, minScore) {
  if (!query.trim() || state.index.length === 0) return [];

  const q = query.toLowerCase().replace(/\s+/g, "");
  if (q.length < 1) return [];

  const results = [];
  for (const item of state.index) {
    const searchText = item._searchText.replace(/\s+/g, "");
    const idx = searchText.indexOf(q);
    if (idx === -1) continue;

    // 匹配位置越靠前，分数越高
    const posScore = Math.max(0, 1 - idx / Math.max(searchText.length, 1));
    // 匹配次数（可能有多次出现）
    let count = 0;
    let pos = 0;
    while ((pos = searchText.indexOf(q, pos)) !== -1) { count++; pos += q.length; }
    const countBoost = Math.min(0.3, count * 0.05);

    // 章节标题匹配额外加分
    let titleBoost = 0;
    if (item.c && item.c.replace(/\s+/g, "").indexOf(q) !== -1) {
      titleBoost = 0.2;
    }

    results.push({
      chunk: item,
      score: Math.min(1, posScore * 0.6 + countBoost + titleBoost + 0.2),
    });
  }

  return selectDiverseResults(results, topK, minScore);
}

/**
 * 模糊检索：两阶段 keyword + n-gram 混合搜索（增强版）。
 *   Stage 1: 关键词过滤 → top 300 候选
 *   Stage 2: n-gram 余弦相似度精排（含 IDF 加权 + 短语加分 + 章节标题加权）
 */
function searchFuzzy(query, topK, minScore) {
  if (!query.trim() || state.index.length === 0) return [];

  const queryTokens = tokenize(query);
  const queryGrams = makeGrams(query);
  const phrase = longestQueryToken(queryTokens);

  const tokenDF = estimateTokenDF(queryTokens);

  // Stage 1: 关键词评分（含 IDF 加权）
  const CANDIDATE_LIMIT = 300;
  const candidates = [];
  for (const item of state.index) {
    const kwScore = keywordCoverage(item._searchText, queryTokens, tokenDF);
    if (kwScore > 0) {
      candidates.push({ item, kwScore });
    }
  }

  // 按关键词分数排序，取 top CANDIDATE_LIMIT
  candidates.sort((a, b) => b.kwScore - a.kwScore);
  const topCandidates = candidates.slice(0, CANDIDATE_LIMIT);

  // Stage 2: 完整 n-gram 评分
  const scored = topCandidates.map(({ item }) => {
    const chunkGrams = makeGrams(item._searchText);
    const ngramScore = cosineLike(queryGrams, chunkGrams);

    const keywordScore = keywordCoverage(item._searchText, queryTokens, tokenDF);
    const titleScore = keywordCoverage((item.c || "").toLowerCase(), queryTokens, tokenDF);
    // 完整短语连续出现
    const compact = item._searchText.replace(/\s+/g, "");
    const exactBoost = phrase.length >= 3 && compact.includes(phrase) ? 0.15 : 0;

    return {
      chunk: item,
      score: Math.min(
        1,
        keywordScore * 0.5 + ngramScore * 0.3 + titleScore * 0.15 + exactBoost,
      ),
    };
  });

  return selectDiverseResults(scored, topK, minScore);
}

/**
 * 静态降级模式的语义精排。语义扩展词先提供跨表达召回；如果本地同时有
 * 与索引版本一致的 embeddings.bin，再使用候选片段质心扩展近邻结果。
 */
async function searchSemantic(query, topK, minScore, semanticTerms = []) {
  if (!query.trim() || state.index.length === 0) return [];

  const expandedQuery = [query, ...semanticTerms].join(" ");
  const queryTokens = tokenize(expandedQuery);
  const queryGrams = makeGrams(expandedQuery);
  const phrase = longestQueryToken(queryTokens);
  const N = state.index.length;
  const useEmbeddings = hasSemanticSearch();

  const tokenDF = estimateTokenDF(queryTokens);

  // 如果有 embeddings，用候选集的加权质心作为 query 代理向量
  let queryEmbeddingScores = null;
  if (useEmbeddings) {
    // 第一阶段：快速关键词筛选候选集
    const fastCands = [];
    for (let i = 0; i < N; i++) {
      const quickScore = keywordCoverage(
        state.index[i]._searchText,
        queryTokens,
        tokenDF,
      );
      if (quickScore > 0) fastCands.push({ idx: i, quickScore });
    }
    fastCands.sort((a, b) => b.quickScore - a.quickScore);
    const topFast = fastCands.slice(0, 500);

    // 用候选集加权质心作为 query 代理向量
    const { dim, buffer, min: fmin, max: fmax } = state.embeddings;
    const scale = (fmax - fmin) / 255.0;
    const uint8View = new Uint8Array(buffer, 4, N * dim);
    const proxyVec = new Float32Array(dim);
    let totalWeight = 0;
    for (const c of topFast) {
      const base = c.idx * dim;
      const weight = c.quickScore;
      for (let d = 0; d < dim; d++) {
        proxyVec[d] += (uint8View[base + d] * scale + fmin) * weight;
      }
      totalWeight += weight;
    }
    if (totalWeight > 0) {
      for (let d = 0; d < dim; d++) proxyVec[d] /= totalWeight;
    }
    const norm = Math.sqrt(proxyVec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let d = 0; d < dim; d++) proxyVec[d] /= norm;
    }

    // 计算所有 chunk 的向量相似度（分批）
    queryEmbeddingScores = new Float32Array(N);
    const BATCH = 2000;
    for (let offset = 0; offset < N; offset += BATCH) {
      const end = Math.min(offset + BATCH, N);
      for (let i = offset; i < end; i++) {
        let dot = 0;
        const base = i * dim;
        for (let d = 0; d < dim; d++) {
          dot += proxyVec[d] * (uint8View[base + d] * scale + fmin);
        }
        queryEmbeddingScores[i] = (dot + 1) / 2;
      }
      if (offset + BATCH < N) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  // 关键词筛选候选集
  const CANDIDATE_LIMIT = 500;
  const candidates = [];
  for (let i = 0; i < N; i++) {
    const item = state.index[i];
    const kwScore = keywordCoverage(item._searchText, queryTokens, tokenDF);
    if (kwScore > 0 || (queryEmbeddingScores && queryEmbeddingScores[i] > 0.3)) {
      const embScore = queryEmbeddingScores ? queryEmbeddingScores[i] : 0;
      candidates.push({
        idx: i,
        item,
        kwScore,
        candidateScore: kwScore * 0.6 + embScore * 0.4,
      });
    }
  }
  candidates.sort((a, b) => b.candidateScore - a.candidateScore);
  const topCands = candidates.slice(0, CANDIDATE_LIMIT);

  // 精排
  const scored = topCands.map(({ idx, item }) => {
    const chunkGrams = makeGrams(item._searchText);
    const ngramScore = cosineLike(queryGrams, chunkGrams);

    const keywordScore = keywordCoverage(item._searchText, queryTokens, tokenDF);
    const titleScore = keywordCoverage((item.c || "").toLowerCase(), queryTokens, tokenDF);
    const compact = item._searchText.replace(/\s+/g, "");
    let phraseBoost = 0;
    if (phrase.length >= 3 && compact.includes(phrase)) phraseBoost = 0.15;

    const embScore = queryEmbeddingScores ? queryEmbeddingScores[idx] : 0;

    const finalScore = embScore > 0
      ? Math.min(1, embScore * 0.45 + ngramScore * 0.2 + keywordScore * 0.2 + titleScore * 0.1 + phraseBoost)
      : Math.min(1, ngramScore * 0.5 + keywordScore * 0.3 + titleScore * 0.1 + phraseBoost);

    return { chunk: item, score: finalScore };
  });

  return selectDiverseResults(scored, topK, minScore);
}

/**
 * 统一搜索入口，根据 state.searchMode 分发。
 */
function search(query, topK, minScore) {
  switch (state.searchMode) {
    case "exact":
      return searchExact(query, topK, minScore);
    case "semantic":
      // 语义搜索是异步的，由 runSearch 特殊处理
      return null;
    case "fuzzy":
    default:
      return searchFuzzy(query, topK, minScore);
  }
}

// ── AI 回答 ───────────────────────────────────────
function buildPrompt(query, results) {
  const evidence = results
    .map((r, i) => {
      return `[${i + 1}] 《${r.chunk.w}》${r.chunk.c}\n${r.text || r.chunk.p}`;
    })
    .join("\n\n");

  return [
    "你是一个严谨的中文文献考据助手。",
    "任务：只根据下面提供的南怀瑾相关资料片段回答问题。",
    "规则：",
    "1. 如果资料片段没有明确支持，不要补充外部知识。",
    '2. 区分"当前资料未找到"和"作者从未说过"。',
    "3. 每个判断都要标注引用编号（如 [1]、[2]）。",
    "4. 如果只是相近主题，不要说成原话或明确观点。",
    "5. 回答末尾列出引用的著作名和章节。",
    "",
    `问题：${query}`,
    "",
    "资料片段：",
    evidence || "无可用片段。",
  ].join("\n");
}

/**
 * 构建多轮对话的 messages 数组。
 * 每轮：user 消息带当轮的检索片段，assistant 消息为回答。
 * 引用使用全局唯一的 [T轮次-片段]，避免多轮中的 [1] 指向错误原文。
 */
function buildConversationMessages(
  query,
  results,
  turnId,
  conversation = state.conversation,
) {
  const systemPrompt =
    "你是一个严谨的中文文献考据助手。" +
    "只根据提供的南怀瑾相关资料片段回答问题。" +
    "资料编号格式为 [T轮次-片段]，每个判断都要原样标注对应编号。" +
    "可以结合历史对话理解追问，但不得把不同轮次的同序号片段混为一谈。" +
    "如果资料没有明确支持，不要补充外部知识。" +
    '区分"当前资料未找到"和"作者从未说过"。' +
    "如果用户追问，请结合之前的对话上下文回答。";

  const evidence = results.map((r, i) => {
    const text = r.text || r.chunk.p;
    return `[T${turnId}-${i + 1}] 《${r.chunk.w}》${r.chunk.c}\n${text}`;
  }).join("\n\n");

  const messages = [{ role: "system", content: systemPrompt }];

  // 携带历史对话（每轮的完整 user prompt + assistant 回答）
  for (const turn of conversation) {
    if (turn.role === "user") {
      // 历史 user 消息：用存储的完整 prompt（含证据）
      messages.push({ role: "user", content: turn.prompt });
    } else {
      messages.push({ role: "assistant", content: turn.content });
    }
  }

  // 当前问题 + 检索片段
  const currentPrompt = [
    `问题：${query}`,
    "",
    "资料片段：",
    evidence || "无可用片段。",
  ].join("\n");
  messages.push({ role: "user", content: currentPrompt });

  return { messages, currentPrompt };
}

function createTurnEvidenceElement(turnId, results) {
  const details = document.createElement("details");
  details.className = "turn-evidence";

  const summary = document.createElement("summary");
  summary.textContent = `引用依据（${results.length} 条）`;
  details.appendChild(summary);

  const list = document.createElement("div");
  list.className = "turn-evidence-list";
  results.forEach((result, index) => {
    const item = document.createElement("article");
    item.className = "turn-evidence-item";
    item.id = `turn-${turnId}-cite-${index + 1}`;

    const head = document.createElement("div");
    head.className = "turn-evidence-head";
    const source = document.createElement("strong");
    source.textContent = `[T${turnId}-${index + 1}] 《${result.work}》`;
    const chapter = document.createElement("span");
    chapter.textContent = result.chapter;
    head.append(source, chapter);

    const body = document.createElement("p");
    body.textContent = result.text || result.preview || "";

    const actions = document.createElement("div");
    actions.className = "turn-evidence-actions";
    const score = document.createElement("span");
    score.textContent = `相关度 ${result.score.toFixed(2)}`;
    actions.appendChild(score);

    const safeUrl = safeExternalUrl(result.sourceUrl);
    if (safeUrl) {
      const link = document.createElement("a");
      link.href = safeUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "原文链接";
      actions.appendChild(link);
    }

    let contextButton = null;
    if (!safeUrl) {
      contextButton = document.createElement("button");
      contextButton.type = "button";
      contextButton.className = "evidence-context";
      contextButton.textContent = "展开上下文";
      contextButton.hidden = true;
      actions.appendChild(contextButton);
    }

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "复制片段";
    copyButton.addEventListener("click", async () => {
      await copyText(`《${result.work}》${result.chapter}\n${result.text || result.preview}`);
      copyButton.textContent = "已复制 ✓";
      setTimeout(() => { copyButton.textContent = "复制片段"; }, 1500);
    });
    actions.appendChild(copyButton);

    item.append(head, actions, body);
    if (contextButton) {
      attachContextBrowser(contextButton, {
        id: result.id,
        work: result.work,
        chapter: result.chapter,
        text: result.text || result.preview || "",
      }, [body]);
    }
    list.appendChild(item);
  });
  details.appendChild(list);
  return details;
}

function removeConversationTurn(turnId) {
  state.conversation = state.conversation.filter((turn) => turn.turnId !== turnId);
  if (typeof document === "undefined") return;
  document.querySelectorAll("[data-conversation-turn]").forEach((node) => {
    if (Number(node.dataset.conversationTurn) === turnId) node.remove();
  });
}

function trimConversationHistory() {
  const userTurns = state.conversation.filter((turn) => turn.role === "user");
  while (userTurns.length > CONVERSATION_MAX_TURNS) {
    const oldest = userTurns.shift();
    removeConversationTurn(oldest.turnId);
  }
}

async function generateAIAnswer(query, results, retrievalQuery = query) {
  if (!state.apiKey) {
    if (els.apiSettings) els.apiSettings.open = true;
    els.apiKeyInput?.focus();
    els.apiSettings?.scrollIntoView({ behavior: "smooth", block: "center" });
    showToast("设置 DeepSeek API Key 后即可生成引用回答");
    return;
  }

  if (state.answerController) state.answerController.abort();
  const answerRequestId = ++state.answerSeq;
  const controller = new AbortController();
  state.answerController = controller;
  const turnId = state.nextTurnId++;
  const resultSnapshots = snapshotResults(results);
  const { messages, currentPrompt } = buildConversationMessages(query, results, turnId);

  els.aiAnswerBtn.disabled = true;
  els.aiAnswerBtn.textContent = "AI 回答中...";
  if (els.quickAskBtn) els.quickAskBtn.disabled = true;

  const convContainer = document.getElementById("conversationList");

  // 第一轮对话时隐藏初始提示
  if (state.conversation.length === 0) {
    els.answerBox.style.display = "none";
  }

  // 追加用户问题到对话历史（存储完整 prompt 以便后续轮次使用）
  state.conversation.push({
    role: "user",
    turnId,
    content: query,
    retrievalQuery,
    prompt: currentPrompt,
    results: resultSnapshots,
  });
  // 对话中的每轮回答已经保存自己的引用依据，不再重复显示会被后续检索覆盖的结果区。
  updateConversationUI();

  // 显示用户问题气泡
  if (convContainer) {
    const userMsgDiv = document.createElement("div");
    userMsgDiv.className = "chat-msg chat-user";
    userMsgDiv.dataset.conversationTurn = String(turnId);
    userMsgDiv.innerHTML =
      '<div class="chat-bubble">' + escapeHtml(query) + "</div>";
    convContainer.appendChild(userMsgDiv);
    convContainer.scrollTop = convContainer.scrollHeight;
  }

  // 创建 AI 流式回答容器
  const msgDiv = document.createElement("div");
  msgDiv.className = "chat-msg chat-assistant";
  msgDiv.dataset.conversationTurn = String(turnId);
  msgDiv.innerHTML =
    '<div class="chat-bubble"><div class="streaming">AI 正在思考<span class="cursor">…</span></div></div>';
  if (convContainer) {
    convContainer.appendChild(msgDiv);
    convContainer.scrollTop = convContainer.scrollHeight;
  }

  try {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages,
        thinking: { type: "disabled" },
        stream: true,
        temperature: state.conversation.length > 2 ? 0.3 : 0.1,
        max_tokens: 2048,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`API ${resp.status}: ${errText.slice(0, 200)}`);
    }
    if (!resp.body) throw new Error("AI 服务没有返回可读取的内容");

    // 流式读取
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let answerText = "";
    let buffer = "";

    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) return;
      const dataStr = trimmed.slice(6);
      if (dataStr === "[DONE]") return;
      try {
        const data = JSON.parse(dataStr);
        const delta = data.choices?.[0]?.delta?.content;
        if (!delta) return;
        answerText += delta;
        const rendered = renderAIText(answerText, turnId);
        const bubble = msgDiv.querySelector(".chat-bubble");
        if (bubble) {
          bubble.innerHTML = '<div class="ai-answer">' + rendered +
            '<span class="cursor">|</span></div>';
          if (convContainer) convContainer.scrollTop = convContainer.scrollHeight;
        }
      } catch {
        // 跳过无法解析的 SSE 行
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(consumeLine);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer);
    if (!answerText.trim()) throw new Error("AI 未返回有效回答，请稍后重试");
    if (answerRequestId !== state.answerSeq) return;

    // 最终回答与本轮原文快照放在同一气泡中，之后的检索不会覆盖它。
    const bubble = msgDiv.querySelector(".chat-bubble");
    if (bubble) {
      const answer = document.createElement("div");
      answer.className = "ai-answer";
      answer.innerHTML = renderAIText(answerText, turnId);
      bubble.replaceChildren(answer, createTurnEvidenceElement(turnId, resultSnapshots));
      if (convContainer) convContainer.scrollTop = convContainer.scrollHeight;
    }

    // 保存到对话历史
    state.conversation.push({ role: "assistant", turnId, content: answerText });
    trimConversationHistory();
    const turnCount = state.conversation.filter((turn) => turn.role === "user").length;
    els.answerStatus.textContent = turnCount > 1
      ? `多轮对话（保留最近 ${turnCount} 轮）`
      : "AI 回答（基于检索片段）";
  } catch (err) {
    removeConversationTurn(turnId);
    if (err.name === "AbortError" || answerRequestId !== state.answerSeq) return;
    els.answerStatus.textContent = `AI 回答失败：${err.message}`;
    showToast("AI 回答失败，请稍后重试");

    // 恢复空对话时的初始状态
    if (state.conversation.length === 0) {
      els.answerBox.style.display = "";
    }
  } finally {
    if (answerRequestId === state.answerSeq) {
      if (state.answerController === controller) state.answerController = null;
      els.aiAnswerBtn.disabled = false;
      els.aiAnswerBtn.textContent = "AI 回答";
      if (els.quickAskBtn) els.quickAskBtn.disabled = false;
      updateConversationUI();
    }
  }
}


// ── 保守回答（无需 API） ─────────────────────────
function buildConservativeAnswer(query, results, strictMode) {
  if (!isSearchReady()) {
    return {
      status: "资料库尚未加载完成。",
      html: "<p>请稍候，搜索索引正在加载中...</p>",
      prompt: "",
    };
  }
  if (!query.trim()) {
    return { status: "请输入问题。", html: "<p>请输入问题或关键词开始检索。</p>", prompt: "" };
  }
  if (results.length === 0) {
    const text = strictMode
      ? "当前资料库中未检索到足以支持回答的明确原文证据。更谨慎的说法是：在已收录资料范围内暂未找到，而不是断言南怀瑾先生从未说过。"
      : "未找到高相关片段，可尝试换用原词、同义词或降低最低分数。";
    return {
      status: "未找到明确证据。",
      html: `<p>${escapeHtml(text)}</p>`,
      prompt: buildPrompt(query, []),
    };
  }

  const top = results[0];
  const direct = top.score >= 0.22 ? "找到较相关的原文片段" : "找到弱相关片段";
  const caveat =
    top.score >= 0.22
      ? "可以基于下列片段做谨慎归纳，但仍应以原文为准。"
      : "这些片段相关性偏弱，不宜据此断定南先生有明确说法。";

  const sourceList = results
    .slice(0, 5)
    .map((r, i) => {
      const src = `《${r.chunk.w}》${r.chunk.c}（相关度 ${r.score.toFixed(2)}）`;
      return `<li><span class="cite-link" data-cite="${i + 1}">[${i + 1}]</span> ${escapeHtml(src)}</li>`;
    })
    .join("");

  return {
    status: `${direct}，共 ${results.length} 条。`,
    html: `<p>${escapeHtml(caveat)}</p><p>建议引用来源：</p><ol>${sourceList}</ol>`,
    prompt: buildPrompt(query, results),
  };
}

// ── 渲染 ──────────────────────────────────────────
function renderLibrary() {
  const works = Object.entries(state.manifest);
  const totalChunks = works.reduce((s, [, v]) => s + v.chunks, 0);
  const totalSize = works.reduce((s, [, v]) => s + v.size, 0);
  els.libraryStats.textContent =
    `${works.length} 部著作 · ${totalChunks.toLocaleString()} 片段 · ${(totalSize / 1024 / 1024).toFixed(0)} MB`;

  els.libraryList.innerHTML = "";
  if (works.length === 0) {
    els.libraryList.innerHTML = '<div class="empty">尚未加载资料库</div>';
    return;
  }

  // 按 chunk 数排序，展示全部著作
  works
    .sort((a, b) => b[1].chunks - a[1].chunks)
    .forEach(([work, info]) => {
      const node = els.docTemplate.content.cloneNode(true);
      node.querySelector("h3").textContent = work;
      node.querySelector("p").textContent =
        `${info.chunks.toLocaleString()} 片段 · ${(info.size / 1024).toFixed(0)} KB`;
      els.libraryList.appendChild(node);
    });
}

function updateModeHelp() {
  if (!els.modeHelp) return;
  els.modeHelp.textContent = state.searchMode === "exact"
    ? "只查找连续出现的完整原句，适合核对明确引文。"
    : "自动融合关键词、模糊匹配与语义召回，直接输入问题即可。";
  els.searchButton.textContent = "检索";
}

function renderSearchInsight(terms = [], effectiveMode = state.searchMode) {
  if (!els.searchInsight) return;
  els.searchInsight.replaceChildren();
  if (state.searchMode !== "semantic") return;

  const label = document.createElement("span");
  label.className = "insight-label";
  if (effectiveMode !== "semantic") {
    label.textContent = "完整原句检索";
    els.searchInsight.appendChild(label);
    return;
  }
  const vectorMode = state.lastSearchMeta?.vectorMode;
  if (vectorMode === "direct") label.textContent = "已融合问题向量与相关概念";
  else if (vectorMode === "neighbors") label.textContent = "已融合语义邻域与相关概念";
  else if (state.lastSearchMeta) label.textContent = state.lastSemanticSource === "ai"
    ? "已使用 AI 相关概念；向量召回暂未启用"
    : "已使用混合字面检索；向量召回暂未启用";
  else if (terms.length > 0) label.textContent = state.lastSemanticSource === "ai"
    ? "AI 理解出的相关概念"
    : "相关概念";
  else return;
  els.searchInsight.appendChild(label);
  for (const term of terms.slice(0, 8)) {
    const chip = document.createElement("span");
    chip.className = "term-chip";
    chip.textContent = term;
    els.searchInsight.appendChild(chip);
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

async function renderResults(query, results, requestId = state.searchSeq) {
  if (requestId !== state.searchSeq) return;
  els.results.innerHTML = "";
  els.resultCount.textContent = `${results.length} 条`;

  if (results.length === 0) {
    els.results.innerHTML = '<div class="empty">没有符合条件的原文片段</div>';
    return;
  }

  // 服务端结果已携带正文；只有静态降级模式才按作品加载 corpus。
  await ensureResultTexts(results);
  if (requestId !== state.searchSeq) return;

  const fragment = document.createDocumentFragment();
  const displayQuery = [query, ...state.lastSemanticTerms].join(" ");
  results.forEach((r, i) => {
    const node = els.resultTemplate.content.cloneNode(true);

    // 为每个结果卡片添加 id，支持从 AI 回答的引用编号跳转
    const card = node.querySelector(".result-card");
    if (card) card.id = `cite-${i + 1}`;

    // 著作名 + 章节
    node.querySelector(".result-work").textContent = r.chunk.w;
    node.querySelector(".result-chapter").textContent = r.chunk.c;

    // 相关度
    node.querySelector(".result-score").textContent =
      `相关度 ${r.score.toFixed(2)} · ${r.chunk.n} 字`;

    // 查找全文
    const corpus = state.textCache.get(r.chunk.w);
    let fullText = r.text || "";
    let sourceUrl = r.sourceUrl || "";
    if (!fullText && corpus) {
      const entry = corpus.get(r.chunk.id);
      if (entry) {
        fullText = entry.t || "";
        sourceUrl = entry.u || "";
      }
    }
    // fallback: 使用 preview
    const displayText = fullText || r.chunk.p;

    // 高亮预览
    const preview = makeContextualSnippet(displayText, displayQuery);
    node.querySelector(".snippet").innerHTML = highlight(preview, displayQuery);

    const copyButton = node.querySelector(".result-copy");
    copyButton.addEventListener("click", async () => {
      await copyText(`《${r.chunk.w}》${r.chunk.c}\n${displayText}`);
      copyButton.textContent = "已复制 ✓";
      setTimeout(() => { copyButton.textContent = "复制片段"; }, 1500);
    });

    // 完整内容
    const detailsEl = node.querySelector("details");
    const preEl = node.querySelector("pre");
    if (fullText && fullText !== r.chunk.p) {
      preEl.textContent = fullText;
      detailsEl.style.display = "";
    } else if (fullText) {
      preEl.textContent = fullText;
      detailsEl.style.display = "";
    } else {
      detailsEl.style.display = "none";
    }

    // 来源链接
    const srcLink = node.querySelector(".result-source");
    const contextButton = node.querySelector(".result-context");
    const safeUrl = safeExternalUrl(sourceUrl);
    if (safeUrl) {
      srcLink.href = safeUrl;
      srcLink.title = safeUrl;
    } else {
      srcLink.style.display = "none";
      attachContextBrowser(contextButton, {
        id: r.chunk.id,
        work: r.chunk.w,
        chapter: r.chunk.c,
        text: displayText,
      }, [node.querySelector(".snippet"), detailsEl]);
    }

    fragment.appendChild(node);
  });
  if (requestId !== state.searchSeq) return;
  els.results.replaceChildren(fragment);
}

function renderAnswer(answer) {
  els.answerStatus.textContent = answer.status;
  els.answerBox.innerHTML = answer.html;
  state.lastPrompt = answer.prompt;
}

// ── 主流程 ────────────────────────────────────────
async function runSearch() {
  if (state.searchController) state.searchController.abort();
  const controller = new AbortController();
  state.searchController = controller;
  const requestId = ++state.searchSeq;
  const query = els.queryInput.value.trim();
  const topK = parseInt(els.topK.value, 10) || 8;
  const parsedMinScore = parseFloat(els.minScore.value);
  const minScore = Number.isFinite(parsedMinScore) ? parsedMinScore : 0.08;
  const strictMode = els.strictMode.checked;
  state.searchMode = els.exactSearch?.checked ? "exact" : "semantic";
  state.lastSearchMeta = null;

  if (!isSearchReady()) {
    els.answerStatus.textContent = "检索服务尚未加载完成";
    return;
  }
  if (!query) {
    state.lastResults = [];
    state.lastSemanticTerms = [];
    renderSearchInsight();
    renderAnswer(buildConservativeAnswer(query, [], strictMode));
    await renderResults(query, [], requestId);
    return;
  }

  els.searchButton.disabled = true;
  els.searchButton.textContent = "检索中...";
  els.answerStatus.textContent = state.searchMode === "semantic"
    ? "正在理解问题并扩展语义..."
    : "正在检索服务端语料...";
  try {
    const semanticTerms = state.searchMode === "semantic"
      ? await expandSemanticQuery(query)
      : [];
    const effectiveMode = state.searchMode;
    state.lastSemanticTerms = semanticTerms;
    renderSearchInsight(semanticTerms, effectiveMode);
    if (state.backendMode !== "remote" && effectiveMode === "semantic" &&
        !hasSemanticSearch()) {
      await checkAndLoadEmbeddings();
    }
    if (requestId !== state.searchSeq) return;
    if (semanticTerms.length > 0) {
      els.answerStatus.textContent = `正在检索相关概念：${semanticTerms.slice(0, 4).join("、")}`;
    }
    let results;
    if (state.backendMode === "remote") {
      results = await searchRemote(
        query,
        topK,
        minScore,
        semanticTerms,
        effectiveMode,
        controller.signal,
      );
    } else if (effectiveMode === "semantic") {
      results = await searchSemantic(query, topK, minScore, semanticTerms);
    } else {
      const requestedMode = state.searchMode;
      state.searchMode = effectiveMode;
      results = search(query, topK, minScore);
      state.searchMode = requestedMode;
    }
    if (requestId !== state.searchSeq) return;
    state.lastSearchMeta = results.meta || null;
    renderSearchInsight(semanticTerms, effectiveMode);
    state.lastResults = results;

    const answer = buildConservativeAnswer(query, results, strictMode);
    renderAnswer(answer);
    await renderResults(query, results, requestId);
    if (typeof history !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("q", query);
      url.searchParams.set("mode", state.searchMode);
      history.replaceState(null, "", url);
    }
  } catch (error) {
    if (requestId !== state.searchSeq) return;
    if (error.name === "AbortError") return;
    state.lastResults = [];
    els.answerStatus.textContent = "检索失败";
    els.answerBox.innerHTML = `<p class="error-msg">${escapeHtml(error.message)}</p>`;
    els.results.innerHTML = '<div class="empty">检索服务暂时不可用，请稍后重试</div>';
    els.resultCount.textContent = "0 条";
  } finally {
    if (requestId === state.searchSeq) {
      if (state.searchController === controller) state.searchController = null;
      els.searchButton.disabled = false;
      updateModeHelp();
    }
  }
}

// ── 多轮对话 ──────────────────────────────────────
function startNewConversation() {
  if (state.answerController) state.answerController.abort();
  state.answerController = null;
  state.answerSeq += 1;
  if (state.searchController) state.searchController.abort();
  state.searchController = null;
  state.searchSeq += 1;
  state.conversation = [];
  els.answerBox.style.display = "";
  els.answerBox.innerHTML =
    '<p>检索后可展开下方“本次检索结果”。点击“AI 回答”可基于原文片段生成带引用的回答（需 API Key）。</p>';
  els.answerStatus.textContent = "新对话已开始";

  // 清空对话列表
  const convList = document.getElementById("conversationList");
  if (convList) convList.innerHTML = "";

  els.aiAnswerBtn.disabled = false;
  els.aiAnswerBtn.textContent = "AI 回答";
  if (els.quickAskBtn) {
    els.quickAskBtn.disabled = false;
    els.quickAskBtn.textContent = "发送";
  }
  updateConversationUI();
}

function updateConversationUI() {
  const hasHistory = state.conversation.length > 0;
  if (els.newChatBtn) {
    els.newChatBtn.style.display = hasHistory ? "" : "none";
  }
  if (els.quickAskBar) {
    els.quickAskBar.style.display = hasHistory ? "flex" : "none";
  }
  if (els.retrievalResultsWrap) {
    els.retrievalResultsWrap.hidden = hasHistory;
  }
}

// ── 初始化 ────────────────────────────────────────
async function init() {
  bindEls();

  const initialParams = new URLSearchParams(window.location.search);
  const initialMode = initialParams.get("mode");
  state.searchMode = initialMode === "exact" ? "exact" : "semantic";
  if (els.exactSearch) els.exactSearch.checked = state.searchMode === "exact";
  if (els.libraryDetails && window.matchMedia("(max-width: 860px)").matches) {
    els.libraryDetails.removeAttribute("open");
  }
  updateModeHelp();

  // 1. 版权声明
  if (!localStorage.getItem(COPYRIGHT_KEY)) {
    els.copyrightGate.style.display = "flex";
    els.loadingOverlay.style.display = "none";
  }

  els.acceptGate.addEventListener("click", () => {
    localStorage.setItem(COPYRIGHT_KEY, Date.now().toString());
    els.copyrightGate.style.display = "none";
    els.loadingOverlay.style.display = "flex";
    startLoading();
  });
  els.retryLoading?.addEventListener("click", startLoading);

  // 如果已接受版权声明，直接开始加载
  if (localStorage.getItem(COPYRIGHT_KEY)) {
    els.copyrightGate.style.display = "none";
    els.loadingOverlay.style.display = "flex";
    await startLoading();
  }

  // 2. API Key 设置
  if (state.apiKey) {
    els.apiKeyInput.value = state.apiKey;
    els.apiStatus.textContent = "已设置";
  }

  els.saveApiKey.addEventListener("click", () => {
    const key = els.apiKeyInput.value.trim();
    if (key) {
      state.apiKey = key;
      localStorage.setItem(API_KEY_STORAGE, key);
      state.semanticCache.clear();
      els.apiStatus.textContent = "已保存 ✓";
      setTimeout(() => { els.apiStatus.textContent = "已设置"; }, 2000);
    } else {
      state.apiKey = "";
      localStorage.removeItem(API_KEY_STORAGE);
      state.semanticCache.clear();
      els.apiStatus.textContent = "已清除，仍可使用基础语义检索";
    }
    updateModeHelp();
  });

  // 3. 事件绑定
  els.searchButton.addEventListener("click", runSearch);
  els.queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  els.topK.addEventListener("change", runSearch);
  els.minScore.addEventListener("change", runSearch);
  els.strictMode.addEventListener("change", runSearch);
  els.exactSearch?.addEventListener("change", () => {
    state.searchMode = els.exactSearch.checked ? "exact" : "semantic";
    state.lastSemanticTerms = [];
    state.lastSearchMeta = null;
    renderSearchInsight([], state.searchMode);
    updateModeHelp();
    if (els.queryInput.value.trim()) runSearch();
  });
  els.queryExamples.forEach((button) => {
    button.addEventListener("click", () => {
      els.queryInput.value = button.dataset.query || "";
      els.queryInput.focus();
      runSearch();
    });
  });

  // 新对话
  if (els.newChatBtn) {
    els.newChatBtn.addEventListener("click", startNewConversation);
  }

  // 追问输入栏
  async function sendFollowUp() {
    const q = els.quickAskInput.value.trim();
    if (!q) return;
    let controller = null;
    els.quickAskInput.value = "";
    els.quickAskBtn.disabled = true;
    try {
      els.queryInput.value = q;
      if (state.searchController) state.searchController.abort();
      controller = new AbortController();
      state.searchController = controller;
      const topK = parseInt(els.topK.value, 10) || 8;
      const parsedMinScore = parseFloat(els.minScore.value);
      const minScore = Number.isFinite(parsedMinScore) ? parsedMinScore : 0.08;

      const requestId = ++state.searchSeq;
      const retrievalQuery = buildFollowUpRetrievalQuery(q);
      const semanticTerms = state.searchMode === "semantic"
        ? await expandSemanticQuery(retrievalQuery)
        : [];
      if (requestId !== state.searchSeq) return;
      const effectiveMode = state.searchMode;
      state.lastSemanticTerms = semanticTerms;
      renderSearchInsight(semanticTerms, effectiveMode);
      if (state.backendMode !== "remote" && effectiveMode === "semantic" &&
          !hasSemanticSearch()) {
        await checkAndLoadEmbeddings();
      }
      if (requestId !== state.searchSeq) return;
      let results;
      if (state.backendMode === "remote") {
        results = await searchRemote(
          retrievalQuery,
          topK,
          minScore,
          semanticTerms,
          effectiveMode,
          controller.signal,
        );
      } else if (effectiveMode === "semantic") {
        results = await searchSemantic(retrievalQuery, topK, minScore, semanticTerms);
      } else {
        const requestedMode = state.searchMode;
        state.searchMode = effectiveMode;
        results = search(retrievalQuery, topK, minScore);
        state.searchMode = requestedMode;
      }
      if (requestId !== state.searchSeq) return;
      state.lastSearchMeta = results.meta || null;
      renderSearchInsight(semanticTerms, effectiveMode);
      state.lastResults = results;

      // 服务端结果已经包含全文；静态降级模式按作品补齐。
      els.quickAskBtn.textContent = "加载原文...";
      els.answerStatus.textContent = "正在加载检索片段的全文...";
      await ensureResultTexts(results);
      if (requestId !== state.searchSeq) return;
      await renderResults(retrievalQuery, results, requestId);
      await generateAIAnswer(q, results, retrievalQuery);
    } catch (error) {
      if (error.name === "AbortError") return;
      els.answerStatus.textContent = "追问检索失败";
      showToast(error.message);
    } finally {
      if (state.searchController === controller) state.searchController = null;
      els.quickAskBtn.disabled = false;
      els.quickAskBtn.textContent = "发送";
    }
  }

  if (els.quickAskBtn) {
    els.quickAskBtn.addEventListener("click", sendFollowUp);
  }
  if (els.quickAskInput) {
    els.quickAskInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendFollowUp();
    });
  }

  els.aiAnswerBtn.addEventListener("click", async () => {
    if (state.lastResults.length === 0) {
      showToast("请先搜索到相关片段");
      return;
    }
    // 确保全文已加载（服务端检索结果通常已经携带）
    els.aiAnswerBtn.disabled = true;
    els.aiAnswerBtn.textContent = "正在加载原文...";
    els.answerStatus.textContent = "正在加载检索片段的全文...";

    await ensureResultTexts(state.lastResults);

    await generateAIAnswer(els.queryInput.value, state.lastResults, els.queryInput.value);
  });

  els.copyPrompt.addEventListener("click", async () => {
    if (!state.lastPrompt) return;
    try {
      await copyText(state.lastPrompt);
      els.copyPrompt.textContent = "已复制 ✓";
      setTimeout(() => { els.copyPrompt.textContent = "复制提示词"; }, 1500);
    } catch { showToast("复制失败，请手动选择文本"); }
  });

  // 4. 引用跳转事件委托
  document.addEventListener("click", (e) => {
    const citeLink = e.target.closest(".cite-link");
    if (!citeLink) return;
    const citeNum = citeLink.getAttribute("data-cite");
    if (!citeNum) return;
    const turnId = citeLink.getAttribute("data-turn");
    const target = document.getElementById(
      turnId ? `turn-${turnId}-cite-${citeNum}` : `cite-${citeNum}`,
    );
    if (target) {
      e.preventDefault();
      const evidenceDetails = target.closest("details");
      if (evidenceDetails) evidenceDetails.open = true;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      // 短暂闪烁高亮（如果 :target 不触发）
      target.style.boxShadow = "0 0 0 4px rgba(31,111,99,0.3)";
      target.style.borderColor = "var(--accent)";
      setTimeout(() => {
        target.style.boxShadow = "";
        target.style.borderColor = "";
      }, 1500);
    }
  });

  // 5. URL 参数
  const q = initialParams.get("q");
  if (q) {
    els.queryInput.value = q;
  }
}

async function startLoading() {
  try {
    els.retryLoading.hidden = true;
    els.loadingBar.parentElement.classList.remove("done", "error");
    els.loadingText.textContent = "正在连接检索服务...";
    els.loadingHint.textContent = "语料保存在服务端，浏览器无需下载大索引";
    els.loadingBar.style.width = "15%";

    const [manifestResult, remoteResult] = await Promise.allSettled([
      loadManifest(),
      checkRemoteBackend(),
    ]);
    if (manifestResult.status === "rejected") throw manifestResult.reason;
    renderLibrary();
    els.loadingBar.style.width = "40%";

    let readyText;
    try {
      if (remoteResult.status === "rejected") throw remoteResult.reason;
      const info = remoteResult.value;
      readyText = `已就绪 — ${Number(info.chunks).toLocaleString()} 个服务端检索片段`;
      els.loadingHint.textContent = "每次搜索只返回命中的少量原文片段";
    } catch (remoteError) {
      if (!shouldAllowStaticFallback()) throw remoteError;
      console.warn("服务端检索不可用，进入静态降级模式:", remoteError);
      state.backendMode = "local";
      els.loadingText.textContent = "静态降级模式：正在加载本地索引...";
      els.loadingHint.textContent = "本地或 GitHub Pages 模式仍会下载较大的静态索引";

      const cachedIndex = await loadSearchIndexFromCache();
      if (cachedIndex) {
        state.index = cachedIndex;
      } else {
        let version = "unknown";
        try {
          const response = await fetch(INDEX_VERSION_URL, { cache: "no-cache" });
          if (response.ok) version = (await response.json()).v || version;
        } catch { /* 使用 unknown */ }
        state.index = await loadSearchIndexFromNetwork(version);
        state.indexVersion = version;
      }
      readyText = `已就绪（静态降级）— ${state.index.length.toLocaleString()} 个检索片段`;
    }

    els.loadingBar.style.width = "100%";
    els.loadingText.textContent = readyText;
    els.loadingBar.parentElement.classList.add("done");
    setTimeout(() => {
      els.loadingOverlay.style.display = "none";
    }, 350);

    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    if (q) {
      els.queryInput.value = q;
      await runSearch();
    }
  } catch (err) {
    els.loadingText.textContent = `检索服务尚未就绪：${err.message}`;
    els.loadingHint.textContent = "请在 Vercel 配置 DATABASE_URL，并先运行 npm run db:import";
    els.loadingBar.parentElement.classList.add("error");
    els.retryLoading.hidden = false;
    console.error("初始化失败:", err);
  }
}

function showToast(msg) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.style.cssText =
      "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
      "background:#1e2528;color:#fff;padding:10px 24px;border-radius:8px;" +
      "font-size:14px;z-index:9999;transition:opacity 0.3s;pointer-events:none;";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = "1";
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => { toast.style.opacity = "0"; }, 2500);
}

// ── 启动 ──────────────────────────────────────────
if (typeof document !== "undefined") {
  init();
}

// 仅供无 DOM 的 Node 回归测试使用；浏览器加载时不会进入该分支。
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    state,
    tokenize,
    makeGrams,
    parseAndBuildIndex,
    searchExact,
    searchFuzzy,
    searchSemantic,
    parseSemanticTerms,
    expandSemanticQueryLocally,
    expandSemanticQuery,
    searchRemote,
    fetchChunkContext,
    selectDiverseResults,
    renderAIText,
    makeContextualSnippet,
    buildFollowUpRetrievalQuery,
    buildConversationMessages,
    snapshotResults,
    safeExternalUrl,
    trimConversationHistory,
  };
}
