import {
  buildSemanticSearchTerms,
  buildSearchTerms,
  mergeHybridCandidates,
  normalizeSemanticTerms,
  rankCandidates,
} from "../server/search-core.mjs";
import { embedQuery, vectorLiteral } from "../server/embeddings.mjs";
import {
  databaseErrorDetails,
  isDatabaseTimeout,
  runDatabaseQuery,
} from "../server/database.mjs";

const ALLOWED_MODES = new Set(["fuzzy", "exact", "broad", "semantic"]);
const SEARCH_CACHE_TTL_MS = 2 * 60 * 1000;
const SEARCH_CACHE_LIMIT = 60;
const searchCache = new Map();

function searchCacheKey({ query, mode, topK, minScore, semanticTerms }) {
  return JSON.stringify([query, mode, topK, minScore, semanticTerms]);
}

function getCachedSearch(key) {
  const cached = searchCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  searchCache.delete(key);
  searchCache.set(key, cached);
  return cached.data;
}

function cacheSearch(key, data) {
  searchCache.set(key, { createdAt: Date.now(), data });
  while (searchCache.size > SEARCH_CACHE_LIMIT) {
    searchCache.delete(searchCache.keys().next().value);
  }
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export async function searchHandler(request) {
  if (request.method !== "POST") {
    return json({ error: "仅支持 POST 请求" }, 405);
  }
  if (request.headers.get("x-copyright-accepted") !== "1") {
    return json({ error: "请先确认版权使用声明" }, 403);
  }
  if (!process.env.DATABASE_URL) {
    return json({ error: "服务端数据库尚未配置" }, 503);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: "请求内容不是有效 JSON" }, 400);
  }

  const query = String(input?.query || "").normalize("NFKC").trim();
  const mode = ALLOWED_MODES.has(input?.mode) ? input.mode : "fuzzy";
  const topK = Math.max(3, Math.min(20, Math.trunc(Number(input?.topK) || 8)));
  const minScore = Math.max(0, Math.min(1, Number(input?.minScore) || 0));
  if (!query) return json({ results: [], meta: { mode, candidateCount: 0 } });
  if (query.length > 200) return json({ error: "查询内容不能超过 200 字" }, 400);
  const semanticTerms = normalizeSemanticTerms(input?.semanticTerms, query);
  const cacheKey = searchCacheKey({ query, mode, topK, minScore, semanticTerms });
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    return json({
      ...cached,
      meta: { ...cached.meta, cacheHit: true, elapsedMs: 0 },
    });
  }

  const startedAt = Date.now();
  try {
    const embeddingPromise = mode === "semantic"
      ? embedQuery(query)
      : Promise.resolve({ vector: null, reason: "NOT_REQUESTED" });
    const { resultSets, terms } = await runDatabaseQuery(async (sql) => {
      if (mode === "exact") {
        const exactQuery = query.replace(/[%_\\]+/g, " ").replace(/\s+/g, " ").trim();
        if (!exactQuery) return { resultSets: [], terms: [] };
        return {
          terms: [exactQuery],
          resultSets: [await sql`SELECT * FROM rag_search_exact(${exactQuery}, ${Math.max(100, topK * 20)})`],
        };
      }

      const searchTerms = mode === "semantic"
        ? buildSemanticSearchTerms(query, semanticTerms)
        : buildSearchTerms(query);
      if (searchTerms.length === 0) return { resultSets: [], terms: [] };
      const perTerm = Math.max(60, Math.min(140, topK * 12));
      const shortTerms = searchTerms.filter((term) => term.length <= 2);
      const longTerms = searchTerms.filter((term) => term.length > 2);
      // 长词走索引并行召回；所有二字词合并为一次表扫描，但仍逐词保留
      // 相同的 perTerm 候选上限。
      const [shortRows, ...longSets] = await Promise.all([
        shortTerms.length > 1
          ? sql`SELECT * FROM rag_search_short_terms(${shortTerms}, ${perTerm})`
          : shortTerms.length === 1
            ? sql`SELECT * FROM rag_search_short_term(${shortTerms[0]}, ${perTerm})`
            : Promise.resolve([]),
        ...longTerms.map((term) => sql`SELECT * FROM rag_search_term(${term}, ${perTerm})`),
      ]);
      const shortSets = new Map(shortTerms.map((term) => [term, []]));
      if (shortTerms.length === 1) {
        shortSets.set(shortTerms[0], shortRows);
      } else {
        for (const row of shortRows) shortSets.get(row.search_term)?.push(row);
      }
      const longSetsByTerm = new Map(longTerms.map((term, index) => [term, longSets[index]]));
      const resultSets = searchTerms.map((term) => term.length <= 2
        ? shortSets.get(term) || []
        : longSetsByTerm.get(term) || []);
      return { resultSets, terms: searchTerms };
    }, 15000);

    let vectorRows = [];
    let vectorMode = "off";
    let vectorReason = "NOT_REQUESTED";
    if (mode === "semantic") {
      const embedded = await embeddingPromise;
      vectorReason = embedded.reason;
      try {
        if (embedded.vector) {
          const literal = vectorLiteral(embedded.vector);
          vectorRows = await runDatabaseQuery(
            (sql) => sql`SELECT * FROM rag_search_vector(
              ${literal}::halfvec(384), ${Math.max(80, topK * 12)}
            )`,
            8000,
          );
          vectorMode = "direct";
        } else {
          const seeds = resultSets
            .flat()
            .sort((a, b) => Number(b.db_score) - Number(a.db_score))
            .slice(0, 6)
            .map((row) => row.id);
          if (seeds.length > 0) {
            vectorRows = await runDatabaseQuery(
              (sql) => sql`SELECT * FROM rag_search_vector_neighbors(
                ${seeds}, ${Math.max(80, topK * 12)}
              )`,
              8000,
            );
            if (vectorRows.length > 0) vectorMode = "neighbors";
          }
        }
      } catch (vectorError) {
        vectorReason = databaseErrorDetails(vectorError, startedAt).code;
        console.warn("Vector retrieval unavailable; using lexical candidates", {
          code: vectorReason,
        });
      }
    }

    const rows = mode === "exact"
      ? (resultSets[0] || [])
      : mergeHybridCandidates(resultSets, vectorRows);

    const ranked = rankCandidates(rows, query, mode, topK, minScore, semanticTerms);
    const results = ranked.map(({ row, score }) => ({
      id: row.id,
      work: row.work,
      chapter: row.chapter,
      charCount: Number(row.char_count) || String(row.content || "").length,
      preview: String(row.content || "").slice(0, 420),
      text: row.content || "",
      sourceUrl: row.source_url || "",
      score: Number(score.toFixed(4)),
    }));

    const data = {
      results,
      meta: {
        mode,
        terms,
        semanticTerms: mode === "semantic" ? semanticTerms : undefined,
        vectorMode: mode === "semantic" ? vectorMode : undefined,
        vectorReason: mode === "semantic" ? vectorReason : undefined,
        candidateCount: rows.length,
        elapsedMs: Date.now() - startedAt,
      },
    };
    cacheSearch(cacheKey, data);
    return json(data);
  } catch (error) {
    const details = databaseErrorDetails(error, startedAt);
    console.error("RAG search failed", details);
    return json({
      code: details.code,
      error: isDatabaseTimeout(error)
        ? "数据库连接超时，请稍后重试"
        : "检索服务暂时不可用，请稍后重试",
    }, 503);
  }
}

// Vercel Web Handler 格式：返回 Web Response 时必须通过 fetch 导出。
export default { fetch: searchHandler };
