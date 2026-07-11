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
const MANIFEST_URL = "works_manifest.json";
const DB_NAME = "nan-rag-corpus";
const DB_VERSION = 1;
const STORE_WORKS = "works";
const STORE_META = "meta";
const COPYRIGHT_KEY = "nan-copyright-accepted";
const API_KEY_STORAGE = "nan-deepseek-key";
const API_URL = "https://api.deepseek.com/v1/chat/completions";

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

    // AI 回答
    aiAnswerBtn: document.getElementById("aiAnswerBtn"),
    answerStatus: document.getElementById("answerStatus"),
    answerBox: document.getElementById("answerBox"),
    copyPrompt: document.getElementById("copyPrompt"),

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
    .split(/[，。！？、；：,.!?;:\s()[\]《》「」『』"'“”‘’]+/g)
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

// ── 数据加载 ──────────────────────────────────────
async function loadSearchIndex() {
  els.loadingText.textContent = "正在下载搜索索引...";
  els.loadingBar.style.width = "20%";

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
      const pct = 20 + Math.round((loaded / total) * 40);
      els.loadingBar.style.width = pct + "%";
      els.loadingText.textContent =
        `正在下载搜索索引... ${(loaded / 1024 / 1024).toFixed(1)} MB`;
    }
  }

  // 合并并解析
  els.loadingText.textContent = "正在解析搜索索引...";
  const blob = new Blob(chunks);
  const text = await blob.text();
  state.index = JSON.parse(text);

  // 构建 _searchText（w + c + p，lowercase）
  els.loadingText.textContent = "正在构建搜索索引...";
  els.loadingBar.style.width = "70%";
  for (const item of state.index) {
    item._searchText = `${item.w} ${item.c} ${item.p}`.toLowerCase();
  }
  els.loadingBar.style.width = "80%";
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
 * 两阶段搜索：
 *   Stage 1: 关键词匹配所有 index → 取 top 200 候选
 *   Stage 2: 对候选计算 n-gram → 取 top K
 */
function search(query, topK, minScore) {
  if (!query.trim() || state.index.length === 0) return [];

  const queryTokens = tokenize(query);
  const queryGrams = makeGrams(query);
  const phrase = query.replace(/\s+/g, "");

  // Stage 1: 关键词评分（快速，只做 string includes）
  const CANDIDATE_LIMIT = 300;
  const candidates = [];
  for (const item of state.index) {
    let kwScore = 0;
    for (const token of queryTokens) {
      if (token.length === 1) {
        if (item._searchText.includes(token)) kwScore += 0.03;
      } else {
        if (item._searchText.includes(token)) {
          kwScore += Math.min(0.18, token.length * 0.025);
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
    const semanticScore = cosineLike(queryGrams, chunkGrams);

    let keywordScore = 0, exactBoost = 0;
    for (const token of queryTokens) {
      if (token.length === 1) {
        if (item._searchText.includes(token)) keywordScore += 0.03;
      } else {
        if (item._searchText.includes(token)) {
          keywordScore += Math.min(0.18, token.length * 0.025);
          if (item.c.toLowerCase().includes(token)) exactBoost += 0.06;
        }
      }
    }
    const compact = item._searchText.replace(/\s+/g, "");
    if (phrase.length >= 3 && compact.includes(phrase)) exactBoost += 0.28;

    return {
      chunk: item,
      score: Math.min(1, keywordScore + semanticScore * 0.9 + exactBoost),
    };
  });

  return scored
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
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
    '2. 区分“当前资料未找到”和“作者从未说过”。',
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

async function generateAIAnswer(query, results) {
  if (!state.apiKey) {
    showToast("请先在侧边栏设置 DeepSeek API Key");
    return;
  }

  const evidence = results.map((r, i) => {
    const text = r.text || r.chunk.p;
    return `[${i + 1}] 《${r.chunk.w}》${r.chunk.c}\n${text}`;
  }).join("\n\n");

  const systemPrompt =
    "你是一个严谨的中文文献考据助手。" +
    "只根据提供的南怀瑾相关资料片段回答问题。" +
    "每个判断都要标注引用编号。如果资料没有明确支持，不要补充外部知识。" +
    '区分"当前资料未找到"和"作者从未说过"。';

  const userPrompt = [
    `问题：${query}`,
    "",
    "资料片段：",
    evidence || "无可用片段。",
  ].join("\n");

  els.aiAnswerBtn.disabled = true;
  els.aiAnswerBtn.textContent = "AI 回答中...";
  els.answerBox.innerHTML =
    '<div class="streaming"><span class="cursor"></span></div>';

  try {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: true,
        temperature: 0.1,
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
            els.answerBox.innerHTML =
              '<div class="streaming">' +
              escapeHtml(answerText).replace(/\n/g, "<br>") +
              '<span class="cursor">|</span></div>';
          }
        } catch (e) {
          // 跳过无法解析的行
        }
      }
    }

    // 最终渲染
    els.answerBox.innerHTML =
      '<div class="ai-answer">' +
      answerText.replace(/\n/g, "<br>").replace(
        /\[(\d+)\]/g,
        '<sup class="cite">[$1]</sup>'
      ) +
      "</div>";
    els.answerStatus.textContent = "AI 回答（基于检索片段）";
  } catch (err) {
    els.answerBox.innerHTML =
      `<div class="error-msg">AI 回答失败：${escapeHtml(err.message)}</div>`;
    els.answerStatus.textContent = "AI 回答失败";
  } finally {
    els.aiAnswerBtn.disabled = false;
    els.aiAnswerBtn.textContent = "AI 回答";
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
      return `<li>[${i + 1}] ${escapeHtml(src)}</li>`;
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

  results.forEach((r) => {
    const node = els.resultTemplate.content.cloneNode(true);

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

  // 执行搜索
  const results = search(query, topK, minScore);
  state.lastResults = results;

  // 渲染保守回答
  const answer = buildConservativeAnswer(query, results, strictMode);
  renderAnswer(answer);

  // 渲染结果（异步加载全文）
  await renderResults(query, results);
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

  els.aiAnswerBtn.addEventListener("click", async () => {
    if (state.lastResults.length === 0) {
      showToast("请先搜索到相关片段");
      return;
    }
    // 确保全文已加载
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

  // 4. URL 参数
  const params = new URLSearchParams(window.location.search);
  const q = params.get("q");
  if (q) {
    els.queryInput.value = q;
  }
}

async function startLoading() {
  try {
    // 加载 manifest（先展示统计）
    els.loadingText.textContent = "正在加载作品清单...";
    els.loadingBar.style.width = "5%";
    await loadManifest();
    renderLibrary();

    // 加载搜索索引
    await loadSearchIndex();

    // 完成
    els.loadingBar.style.width = "100%";
    els.loadingText.textContent = `已就绪 — ${state.index.length.toLocaleString()} 个检索片段`;
    els.loadingBar.parentElement.classList.add("done");

    setTimeout(() => {
      els.loadingOverlay.style.display = "none";
    }, 600);

    // 如果有 URL 参数，自动搜索
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");
    if (q) {
      await runSearch();
    }
  } catch (err) {
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
