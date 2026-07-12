/**
 * 南怀瑾著作 RAG 检索系统
 *
 * 静态站点，客户端搜索 + DeepSeek AI 回答。
 * 数据预置（search_index.json + corpus/ 按作品分片），
 * 无需服务器，可部署到 GitHub Pages / Cloudflare Pages。
 */

// ── 常量 ──────────────────────────────────────────
const CORPUS_DIR = "corpus/";
const INDEX_URL = "search_index.json";
const INDEX_VERSION_URL = "index_version.json";
const MANIFEST_URL = "works_manifest.json";
const EMBEDDINGS_URL = "embeddings.bin";
const DB_NAME = "nan-rag-corpus";
const DB_VERSION = 3;  // 升级：新增 embeddings store
const STORE_WORKS = "works";
const STORE_META = "meta";
const STORE_INDEX = "indexMeta";
const STORE_EMBEDDINGS = "embeddings";
const COPYRIGHT_KEY = "nan-copyright-accepted";
const API_KEY_STORAGE = "nan-deepseek-key";
const API_URL = "https://api.deepseek.com/v1/chat/completions";
const CONVERSATION_MAX_TURNS = 10;

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

  // 加载状态
  loading: { stage: "idle", current: 0, total: 0 },

  // API
  apiKey: localStorage.getItem(API_KEY_STORAGE) || "",

  // 搜索模式: "fuzzy" | "exact" | "semantic"
  searchMode: "fuzzy",

  // 语义向量（从 embeddings.bin 加载）
  embeddings: null,     // { dim, buffer: ArrayBuffer, min, max, version }

  // 多轮对话
  conversation: [],     // [{ role: "user"|"assistant", content, results? }, ...]
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

    // 侧边栏
    libraryStats: document.getElementById("libraryStats"),
    libraryList: document.getElementById("libraryList"),

    // API 设置
    apiKeyInput: document.getElementById("apiKeyInput"),
    saveApiKey: document.getElementById("saveApiKey"),
    apiStatus: document.getElementById("apiStatus"),

    // 搜索
    queryInput: document.getElementById("queryInput"),
    searchButton: document.getElementById("searchButton"),
    topK: document.getElementById("topK"),
    minScore: document.getElementById("minScore"),
    strictMode: document.getElementById("strictMode"),

    // 搜索模式
    searchModeRadios: document.querySelectorAll('input[name="searchMode"]'),

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
    resultCount: document.getElementById("resultCount"),
    results: document.getElementById("results"),

    // 模板
    docTemplate: document.getElementById("docTemplate"),
    resultTemplate: document.getElementById("resultTemplate"),
  };
}

// ── 工具函数 ──────────────────────────────────────
function tokenize(text) {
  const lower = text.toLowerCase();
  const latin = lower.match(/[a-z0-9]+/g) || [];
  const chinese = lower.match(/[一-鿿]/g) || [];
  const phrases = lower
    .split(/[，。！？、；：,.!?;:\s()[\]《》「」『』"'""'']+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && /[一-鿿]/.test(t));
  return [...new Set([...latin, ...chinese, ...phrases])];
}

function makeGrams(text) {
  const clean = text.toLowerCase().replace(/\s+/g, "");
  const grams = new Map();
  for (let n = 2; n <= 4; n += 1) {
    for (let i = 0; i <= clean.length - n; i += 1) {
      const gram = clean.slice(i, i + n);
      if (!/[一-鿿a-z0-9]/.test(gram)) continue;
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlight(text, query) {
  const tokens = tokenize(query)
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 12);
  let out = escapeHtml(text);
  tokens.forEach((token) => {
    const safe = escapeRegExp(escapeHtml(token));
    out = out.replace(new RegExp(safe, "gi"), (m) => `<mark>${m}</mark>`);
  });
  return out;
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
    tx.objectStore(STORE_WORKS).put({ work, ...data, cachedAt: Date.now() });
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
      const db = await openDB();
      await loadSearchIndexFromNetwork(info.v);
      db.close();
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

  return { dim, buffer, min: fmin, max: fmax };
}

/**
 * 从 IndexedDB 加载缓存的 embeddings。
 */
async function loadEmbeddingsFromCache() {
  try {
    const db = await openDB();
    const cached = await getCachedEmbeddings(db);
    db.close();
    if (cached) {
      console.log(`从 IndexedDB 加载 embeddings (v${cached.version}, ${cached.dim} 维)`);
      return {
        dim: cached.dim,
        buffer: cached.buffer,
        min: cached.min,
        max: cached.max,
        version: cached.version,
      };
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
  return state.embeddings !== null && state.embeddings.buffer.byteLength > 12;
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
      const embVersion = vInfo.v || "unknown";
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
      if (cached && cached.chunks) {
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
  return promise;
}

// ── 搜索 ──────────────────────────────────────────
/**
 * 精确全文检索：字面子串匹配。
 * 在 _searchText 中查找用户输入作为完整子串，按匹配位置和次数排名。
 */
function searchExact(query, topK, minScore) {
  if (!query.trim() || state.index.length === 0) return [];

  const q = query.replace(/\s+/g, "");
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

  return results
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
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
  const phrase = query.replace(/\s+/g, "");

  // 计算 IDF-like 权重（稀有 token 权重更高）
  const N = state.index.length;
  const tokenDF = new Map();
  for (const token of queryTokens) {
    if (token.length < 2) continue;
    let df = 0;
    // 采样估算 DF（全量计算太慢，取前 5000 条 + 随机抽样 5000 条）
    const sampleSize = Math.min(10000, N);
    const step = Math.max(1, Math.floor(N / sampleSize));
    for (let i = 0; i < N; i += step) {
      if (state.index[i]._searchText.includes(token)) df++;
    }
    tokenDF.set(token, Math.max(1, df));
  }

  // Stage 1: 关键词评分（含 IDF 加权）
  const CANDIDATE_LIMIT = 300;
  const candidates = [];
  for (const item of state.index) {
    let kwScore = 0;
    for (const token of queryTokens) {
      if (token.length === 1) {
        if (item._searchText.includes(token)) kwScore += 0.02;
      } else {
        if (item._searchText.includes(token)) {
          const idf = Math.log(N / (tokenDF.get(token) || 1));
          kwScore += Math.min(0.22, token.length * 0.025) * Math.min(3, idf);
          // 章节标题中出现 → 额外加权
          if (item.c && item.c.toLowerCase().includes(token)) {
            kwScore += 0.08;
          }
        }
      }
    }
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

    let keywordScore = 0, exactBoost = 0;
    for (const token of queryTokens) {
      if (token.length === 1) {
        if (item._searchText.includes(token)) keywordScore += 0.02;
      } else {
        if (item._searchText.includes(token)) {
          const idf = Math.log(N / (tokenDF.get(token) || 1));
          keywordScore += Math.min(0.22, token.length * 0.025) * Math.min(3, idf);
          if (item.c && item.c.toLowerCase().includes(token)) exactBoost += 0.08;
        }
      }
    }
    // 完整短语连续出现
    const compact = item._searchText.replace(/\s+/g, "");
    if (phrase.length >= 3 && compact.includes(phrase)) exactBoost += 0.30;

    return {
      chunk: item,
      score: Math.min(1, keywordScore + ngramScore * 0.85 + exactBoost),
    };
  });

  return scored
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * 语义检索：调用 DeepSeek embedding API 获取 query vector，
 * 与预计算的 chunk embeddings 做余弦相似度计算，混合关键词分数。
 * 需要 API Key 和已加载的 embeddings.bin。
 */
/**
 * 语义检索（增强版模糊检索）：更侧重 n-gram 语义相似度，弱化精确关键词匹配。
 * 如果预计算 embeddings 可用则同时使用向量相似度。
 * 完全在浏览器内运行，不需要 API Key。
 */
async function searchSemantic(query, topK, minScore) {
  if (!query.trim() || state.index.length === 0) return [];

  const queryTokens = tokenize(query);
  const queryGrams = makeGrams(query);
  const phrase = query.replace(/\s+/g, "");
  const N = state.index.length;
  const useEmbeddings = hasSemanticSearch();

  // 计算 IDF-like 权重
  const tokenDF = new Map();
  for (const token of queryTokens) {
    if (token.length < 2) continue;
    let df = 0;
    const sampleSize = Math.min(10000, N);
    const step = Math.max(1, Math.floor(N / sampleSize));
    for (let i = 0; i < N; i += step) {
      if (state.index[i]._searchText.includes(token)) df++;
    }
    tokenDF.set(token, Math.max(1, df));
  }

  // 如果有 embeddings，用候选集的加权质心作为 query 代理向量
  let queryEmbeddingScores = null;
  if (useEmbeddings) {
    // 第一阶段：快速关键词筛选候选集
    const fastCands = [];
    for (let i = 0; i < N; i++) {
      let quickScore = 0;
      for (const token of queryTokens) {
        if (token.length >= 2 && state.index[i]._searchText.includes(token)) {
          quickScore += 0.1;
        }
      }
      if (quickScore > 0) fastCands.push({ idx: i, quickScore });
    }
    fastCands.sort((a, b) => b.quickScore - a.quickScore);
    const topFast = fastCands.slice(0, 500);

    // 用候选集加权质心作为 query 代理向量
    const { dim, buffer, min: fmin, max: fmax } = state.embeddings;
    const scale = (fmax - fmin) / 255.0;
    const int8View = new Int8Array(buffer, 4, N * dim);
    const proxyVec = new Float32Array(dim);
    let totalWeight = 0;
    for (const c of topFast) {
      const base = c.idx * dim;
      const weight = c.quickScore;
      for (let d = 0; d < dim; d++) {
        proxyVec[d] += (int8View[base + d] * scale + fmin) * weight;
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
          dot += proxyVec[d] * (int8View[base + d] * scale + fmin);
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
    let kwScore = 0;
    const item = state.index[i];
    for (const token of queryTokens) {
      if (token.length >= 2 && item._searchText.includes(token)) {
        const idf = Math.log(N / (tokenDF.get(token) || 1));
        kwScore += 0.03 * Math.min(3, idf);
      }
    }
    if (kwScore > 0 || (queryEmbeddingScores && queryEmbeddingScores[i] > 0.3)) {
      candidates.push({ idx: i, item, kwScore });
    }
  }
  candidates.sort((a, b) => b.kwScore - a.kwScore);
  const topCands = candidates.slice(0, CANDIDATE_LIMIT);

  // 精排
  const scored = topCands.map(({ idx, item }) => {
    const chunkGrams = makeGrams(item._searchText);
    const ngramScore = cosineLike(queryGrams, chunkGrams);

    let keywordScore = 0, titleBoost = 0;
    for (const token of queryTokens) {
      if (token.length >= 2 && item._searchText.includes(token)) {
        const idf = Math.log(N / (tokenDF.get(token) || 1));
        keywordScore += 0.02 * Math.min(3, idf);
        if (item.c && item.c.toLowerCase().includes(token)) titleBoost += 0.04;
      }
    }
    const compact = item._searchText.replace(/\s+/g, "");
    let phraseBoost = 0;
    if (phrase.length >= 3 && compact.includes(phrase)) phraseBoost = 0.15;

    const embScore = queryEmbeddingScores ? queryEmbeddingScores[idx] : 0;

    const finalScore = embScore > 0
      ? Math.min(1, embScore * 0.6 + ngramScore * 0.25 + keywordScore + titleBoost + phraseBoost)
      : Math.min(1, ngramScore * 0.8 + keywordScore + titleBoost + phraseBoost);

    return { chunk: item, score: finalScore };
  });

  return scored
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
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
 * 不重复发送历史片段以节省 token。
 */
function buildConversationMessages(query, results) {
  const systemPrompt =
    "你是一个严谨的中文文献考据助手。" +
    "只根据提供的南怀瑾相关资料片段回答问题。" +
    "每个判断都要标注引用编号。如果资料没有明确支持，不要补充外部知识。" +
    '区分"当前资料未找到"和"作者从未说过"。' +
    "如果用户追问，请结合之前的对话上下文回答。";

  const evidence = results.map((r, i) => {
    const text = r.text || r.chunk.p;
    return `[${i + 1}] 《${r.chunk.w}》${r.chunk.c}\n${text}`;
  }).join("\n\n");

  const messages = [{ role: "system", content: systemPrompt }];

  // 携带历史对话（每轮的完整 user prompt + assistant 回答）
  for (const turn of state.conversation) {
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

async function generateAIAnswer(query, results) {
  if (!state.apiKey) {
    showToast("请先在侧边栏设置 DeepSeek API Key");
    return;
  }

  const { messages, currentPrompt } = buildConversationMessages(query, results);

  els.aiAnswerBtn.disabled = true;
  els.aiAnswerBtn.textContent = "AI 回答中...";

  const convContainer = document.getElementById("conversationList");

  // 第一轮对话时隐藏初始提示
  if (state.conversation.length === 0) {
    els.answerBox.style.display = "none";
  }

  // 追加用户问题到对话历史（存储完整 prompt 以便后续轮次使用）
  state.conversation.push({
    role: "user",
    content: query,
    prompt: currentPrompt,
    results: results.map((r) => ({
      work: r.chunk.w,
      chapter: r.chunk.c,
      score: r.score,
    })),
  });

  // 显示用户问题气泡
  if (convContainer) {
    const userMsgDiv = document.createElement("div");
    userMsgDiv.className = "chat-msg chat-user";
    userMsgDiv.innerHTML =
      '<div class="chat-bubble">' + escapeHtml(query) + "</div>";
    convContainer.appendChild(userMsgDiv);
    convContainer.scrollTop = convContainer.scrollHeight;
  }

  // 创建 AI 流式回答容器
  const msgId = "msg-" + Date.now();
  const msgDiv = document.createElement("div");
  msgDiv.className = "chat-msg chat-assistant";
  msgDiv.id = msgId;
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
      body: JSON.stringify({
        model: "deepseek-chat",
        messages,
        stream: true,
        temperature: state.conversation.length > 2 ? 0.3 : 0.1,
        max_tokens: 2048,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`API ${resp.status}: ${errText.slice(0, 200)}`);
    }

    // 流式读取
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let answerText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === "[DONE]") continue;

        try {
          const data = JSON.parse(dataStr);
          const delta = data.choices?.[0]?.delta?.content;
          if (delta) {
            answerText += delta;
            const rendered = escapeHtml(answerText)
              .replace(/\n/g, "<br>")
              .replace(/\[(\d+)\]/g, '<span class="cite-link" data-cite="$1"><sup class="cite">[$1]</sup></span>');
            if (msgDiv) {
              // 清除"思考中"状态，首次显示实际内容
              msgDiv.querySelector(".chat-bubble").innerHTML =
                '<div class="ai-answer">' + rendered +
                '<span class="cursor">|</span></div>';
              if (convContainer) {
                convContainer.scrollTop = convContainer.scrollHeight;
              }
            }
          }
        } catch (e) {
          // 跳过无法解析的行
        }
      }
    }

    // 最终渲染
    const finalHtml = '<div class="ai-answer">' +
      answerText
        .replace(/\n/g, "<br>")
        .replace(/\[(\d+)\]/g, '<span class="cite-link" data-cite="$1"><sup class="cite">[$1]</sup></span>') +
      "</div>";

    if (msgDiv) {
      msgDiv.querySelector(".chat-bubble").innerHTML = finalHtml;
      if (convContainer) {
        convContainer.scrollTop = convContainer.scrollHeight;
      }
    }
    els.answerStatus.textContent =
      state.conversation.length >= 2
        ? `多轮对话（第 ${Math.floor(state.conversation.length / 2) + 1} 轮）`
        : "AI 回答（基于检索片段）";

    // 保存到对话历史
    state.conversation.push({ role: "assistant", content: answerText });

    // 限制对话轮数
    while (state.conversation.length > CONVERSATION_MAX_TURNS * 2) {
      state.conversation.shift();
    }
  } catch (err) {
    // 移除失败的用户消息（从历史和 UI）
    while (state.conversation.length > 0 &&
           state.conversation[state.conversation.length - 1].role === "user") {
      state.conversation.pop();
    }
    // 移除 UI 中的用户气泡
    if (convContainer && msgDiv && msgDiv.previousElementSibling &&
        msgDiv.previousElementSibling.classList.contains("chat-user")) {
      msgDiv.previousElementSibling.remove();
    }
    // 移除 AI 消息容器
    if (msgDiv) msgDiv.remove();

    const errHtml = '<div class="error-msg">AI 回答失败：' +
      escapeHtml(err.message) + "</div>";
    els.answerStatus.textContent = "AI 回答失败";

    // 恢复空对话时的初始状态
    if (state.conversation.length === 0) {
      els.answerBox.style.display = "";
    }
  } finally {
    els.aiAnswerBtn.disabled = false;
    els.aiAnswerBtn.textContent = "AI 回答";
    updateConversationUI();
  }
}


// ── 保守回答（无需 API） ─────────────────────────
function buildConservativeAnswer(query, results, strictMode) {
  if (state.index.length === 0) {
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

  // 按 chunk 数排序，取前 30 部展示
  works
    .sort((a, b) => b[1].chunks - a[1].chunks)
    .slice(0, 30)
    .forEach(([work, info]) => {
      const node = els.docTemplate.content.cloneNode(true);
      node.querySelector("h3").textContent = work;
      node.querySelector("p").textContent =
        `${info.chunks.toLocaleString()} 片段 · ${(info.size / 1024).toFixed(0)} KB`;
      els.libraryList.appendChild(node);
    });

  if (works.length > 30) {
    const more = document.createElement("div");
    more.className = "empty";
    more.textContent = `... 还有 ${works.length - 30} 部著作`;
    els.libraryList.appendChild(more);
  }
}

async function renderResults(query, results) {
  els.results.innerHTML = "";
  els.resultCount.textContent = `${results.length} 条`;

  if (results.length === 0) {
    els.results.innerHTML = '<div class="empty">没有符合条件的原文片段</div>';
    return;
  }

  // 收集需要加载的 work
  const neededWorks = new Set(results.map((r) => r.chunk.w));

  // 并行加载所有需要的 corpus
  await Promise.all(
    [...neededWorks].map((w) =>
      loadCorpusForWork(w).catch(() => {})
    )
  );

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
    let fullText = "";
    let sourceUrl = "";
    if (corpus) {
      const entry = corpus.get(r.chunk.id);
      if (entry) {
        fullText = entry.t || "";
        sourceUrl = entry.u || "";
      }
    }
    // fallback: 使用 preview
    const displayText = fullText || r.chunk.p;

    // 高亮预览
    const compact = displayText.replace(/\s+/g, " ").trim();
    const preview = compact.length > 300 ? compact.slice(0, 300) + "..." : compact;
    node.querySelector(".snippet").innerHTML = highlight(preview, query);

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
    if (sourceUrl) {
      srcLink.href = sourceUrl;
      srcLink.title = sourceUrl;
    } else {
      srcLink.style.display = "none";
    }

    els.results.appendChild(node);
  });
}

function renderAnswer(answer) {
  els.answerStatus.textContent = answer.status;
  els.answerBox.innerHTML = answer.html;
  state.lastPrompt = answer.prompt;
}

// ── 主流程 ────────────────────────────────────────
async function runSearch() {
  const query = els.queryInput.value;
  const topK = parseInt(els.topK.value, 10) || 8;
  const minScore = parseFloat(els.minScore.value) || 0.08;
  const strictMode = els.strictMode.checked;

  if (state.index.length === 0) {
    els.answerStatus.textContent = "搜索索引尚未加载完成";
    return;
  }

  // 根据搜索模式执行
  let results;
  if (state.searchMode === "semantic") {
    els.answerStatus.textContent = "语义检索中...";
    results = await searchSemantic(query, topK, minScore);
  } else {
    results = search(query, topK, minScore);
  }
  state.lastResults = results;

  // 渲染保守回答（多轮对话时跳过，仅首次显示）
  const answer = buildConservativeAnswer(query, results, strictMode);
  renderAnswer(answer);

  // 渲染结果（异步加载全文）
  await renderResults(query, results);
}

// ── 多轮对话 ──────────────────────────────────────
function startNewConversation() {
  state.conversation = [];
  els.answerBox.style.display = "";
  els.answerBox.innerHTML =
    '<p>检索结果将在此显示。点击"AI 回答"基于原文片段生成回答（需 API Key），或点击"复制提示词"手动粘贴到任意 LLM。</p>';
  els.answerStatus.textContent = "新对话已开始";

  // 清空对话列表
  const convList = document.getElementById("conversationList");
  if (convList) convList.innerHTML = "";

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
}

// ── 初始化 ────────────────────────────────────────
async function init() {
  bindEls();

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
      els.apiStatus.textContent = "已保存 ✓";
      setTimeout(() => { els.apiStatus.textContent = "已设置"; }, 2000);
    }
  });

  // 3. 事件绑定
  els.searchButton.addEventListener("click", runSearch);
  els.queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  els.topK.addEventListener("change", runSearch);
  els.minScore.addEventListener("change", runSearch);
  els.strictMode.addEventListener("change", runSearch);

  // 搜索模式切换
  els.searchModeRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        state.searchMode = radio.value;
        // 语义模式需要 embeddings 数据
        if (state.searchMode === "semantic" && !hasSemanticSearch()) {
          checkAndLoadEmbeddings().then((ok) => {
            if (!ok) {
              showToast("语义向量数据不可用，已切换回模糊搜索");
              state.searchMode = "fuzzy";
              const fuzzyRadio = document.querySelector('input[name="searchMode"][value="fuzzy"]');
              if (fuzzyRadio) fuzzyRadio.checked = true;
            }
          });
        }
        // 自动重新搜索
        if (els.queryInput.value.trim()) runSearch();
      }
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
    els.quickAskInput.value = "";
    els.quickAskBtn.disabled = true;

    // 同步到主搜索框
    els.queryInput.value = q;

    // 执行搜索
    const topK = parseInt(els.topK.value, 10) || 8;
    const minScore = parseFloat(els.minScore.value) || 0.08;

    let results;
    if (state.searchMode === "semantic") {
      results = await searchSemantic(q, topK, minScore);
    } else {
      results = search(q, topK, minScore);
    }
    state.lastResults = results;

    // 加载全文
    els.quickAskBtn.textContent = "加载原文...";
    els.answerStatus.textContent = "正在加载检索片段的全文...";
    const neededWorks = new Set(results.map((r) => r.chunk.w));
    await Promise.all([...neededWorks].map((w) => loadCorpusForWork(w).catch(() => {})));
    for (const r of results) {
      const corpus = state.textCache.get(r.chunk.w);
      if (corpus) {
        const entry = corpus.get(r.chunk.id);
        if (entry) r.text = entry.t;
      }
    }

    // 更新原文片段区域（使 AI 回答中的引用编号可点击跳转）
    await renderResults(q, results);

    // 直接调用 AI 回答
    await generateAIAnswer(q, results);
    els.quickAskBtn.disabled = false;
    els.quickAskBtn.textContent = "发送";
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
    // 确保全文已加载
    els.aiAnswerBtn.disabled = true;
    els.aiAnswerBtn.textContent = "正在加载原文...";
    els.answerStatus.textContent = "正在加载检索片段的全文...";

    const neededWorks = new Set(state.lastResults.map((r) => r.chunk.w));
    await Promise.all([...neededWorks].map((w) => loadCorpusForWork(w).catch(() => {})));

    // 填充全文
    for (const r of state.lastResults) {
      const corpus = state.textCache.get(r.chunk.w);
      if (corpus) {
        const entry = corpus.get(r.chunk.id);
        if (entry) r.text = entry.t;
      }
    }

    await generateAIAnswer(els.queryInput.value, state.lastResults);
  });

  els.copyPrompt.addEventListener("click", async () => {
    if (!state.lastPrompt) return;
    try {
      await navigator.clipboard.writeText(state.lastPrompt);
      els.copyPrompt.textContent = "已复制 ✓";
      setTimeout(() => { els.copyPrompt.textContent = "复制提示词"; }, 1500);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = state.lastPrompt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      els.copyPrompt.textContent = "已复制 ✓";
      setTimeout(() => { els.copyPrompt.textContent = "复制提示词"; }, 1500);
    }
  });

  // 4. 引用跳转事件委托
  document.addEventListener("click", (e) => {
    const citeLink = e.target.closest(".cite-link");
    if (!citeLink) return;
    const citeNum = citeLink.getAttribute("data-cite");
    if (!citeNum) return;
    const target = document.getElementById(`cite-${citeNum}`);
    if (target) {
      e.preventDefault();
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
  const params = new URLSearchParams(window.location.search);
  const q = params.get("q");
  if (q) {
    els.queryInput.value = q;
  }
}

async function startLoading() {
  try {
    // Step 1: 并行加载 manifest + 检查索引版本
    els.loadingText.textContent = "正在检查缓存...";
    els.loadingBar.style.width = "3%";

    // 加载 manifest（小文件，很快）
    const manifestPromise = loadManifest();

    // 获取服务器端索引版本（< 100 字节，极快）
    let serverVersion = null;
    let serverIndexSize = null;
    try {
      const vResp = await fetch(INDEX_VERSION_URL, { cache: "no-cache" });
      if (vResp.ok) {
        const vInfo = await vResp.json();
        serverVersion = vInfo.v;
        serverIndexSize = vInfo.size;
        // 动态更新加载提示，显示实际文件大小
        if (serverIndexSize && els.loadingHint) {
          const sizeMB = (serverIndexSize / 1024 / 1024).toFixed(1);
          els.loadingHint.textContent =
            `首次访问需下载索引（约 ${sizeMB} MB），之后自动从本地缓存加载，秒开`;
        }
      }
    } catch (e) {
      console.warn("无法获取索引版本信息:", e);
    }

    await manifestPromise;
    renderLibrary();
    els.loadingBar.style.width = "8%";

    // Step 2: 尝试从 IndexedDB 缓存加载索引
    let cachedVersion = null;
    const cachedIndex = await loadSearchIndexFromCache();

    if (cachedIndex && serverVersion) {
      // 检查版本是否匹配
      try {
        const db = await openDB();
        const cached = await getCachedIndex(db);
        db.close();
        if (cached) cachedVersion = cached.version;
      } catch (e) { /* ignore */ }
    }

    if (cachedIndex && cachedVersion === serverVersion) {
      // ✅ 缓存命中且版本匹配 — 秒开！
      state.index = cachedIndex;
      els.loadingBar.style.width = "100%";
      els.loadingText.textContent =
        `已就绪（缓存）— ${state.index.length.toLocaleString()} 个检索片段`;
      els.loadingBar.parentElement.classList.add("done");

      // 后台加载 embeddings
      loadEmbeddingsFromCache().then((emb) => {
        if (emb) state.embeddings = emb;
      });

      setTimeout(() => {
        els.loadingOverlay.style.display = "none";
      }, 300);

      // 自动搜索 URL 参数
      const params = new URLSearchParams(window.location.search);
      const q = params.get("q");
      if (q) {
        els.queryInput.value = q;
        await runSearch();
      }
      return;
    }

    if (cachedIndex) {
      // 缓存存在但版本过期 — 先用缓存，后台更新
      console.log(`索引版本过期（缓存: ${cachedVersion}, 服务器: ${serverVersion}），先用缓存，后台更新`);
      state.index = cachedIndex;
      els.loadingBar.style.width = "100%";
      els.loadingText.textContent =
        `已就绪（缓存）— ${state.index.length.toLocaleString()} 个检索片段`;
      els.loadingBar.parentElement.classList.add("done");

      // 后台加载 embeddings
      loadEmbeddingsFromCache().then((emb) => {
        if (emb) state.embeddings = emb;
      });

      setTimeout(() => {
        els.loadingOverlay.style.display = "none";
      }, 300);

      // 后台下载新版本
      if (serverVersion) {
        checkForIndexUpdate(cachedVersion).catch(() => {});
      }

      const params = new URLSearchParams(window.location.search);
      const q = params.get("q");
      if (q) {
        els.queryInput.value = q;
        await runSearch();
      }
      return;
    }

    // Step 3: 无缓存 — 从网络下载（首次访问）
    els.loadingText.textContent = "首次使用，正在下载搜索索引...";
    els.loadingBar.style.width = "10%";

    const version = serverVersion || "unknown";
    state.index = await loadSearchIndexFromNetwork(version);

    // 完成
    els.loadingBar.style.width = "100%";
    els.loadingText.textContent =
      `已就绪 — ${state.index.length.toLocaleString()} 个检索片段`;
    els.loadingBar.parentElement.classList.add("done");

    // 后台加载 embeddings（首次访问：从网络下载）
    loadEmbeddingsFromCache().then((emb) => {
      if (emb) {
        state.embeddings = emb;
      } else {
        // 缓存中没有，尝试从网络加载
        loadEmbeddingsFromNetwork(version).then((netEmb) => {
          if (netEmb) state.embeddings = netEmb;
        }).catch(() => {});
      }
    });

    setTimeout(() => {
      els.loadingOverlay.style.display = "none";
    }, 600);

    // 自动搜索 URL 参数
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    if (q) {
      els.queryInput.value = q;
      await runSearch();
    }
  } catch (err) {
    // 如果网络失败但 IndexedDB 有旧缓存，仍可使用
    try {
      const fallback = await loadSearchIndexFromCache();
      if (fallback) {
        state.index = fallback;
        els.loadingBar.style.width = "100%";
        els.loadingText.textContent =
          `已就绪（离线缓存）— ${state.index.length.toLocaleString()} 个检索片段`;
        els.loadingBar.parentElement.classList.add("done");
        // 加载缓存的 embeddings
        loadEmbeddingsFromCache().then((emb) => {
          if (emb) state.embeddings = emb;
        });
        setTimeout(() => {
          els.loadingOverlay.style.display = "none";
        }, 300);
        console.warn("网络加载失败，使用 IndexedDB 离线缓存");
        return;
      }
    } catch (e2) { /* ignore */ }

    els.loadingText.textContent = `加载失败：${err.message}`;
    els.loadingBar.parentElement.classList.add("error");
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
init();
