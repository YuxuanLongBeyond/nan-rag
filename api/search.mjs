import {
  buildSemanticSearchTerms,
  buildSearchTerms,
  mergeCandidateSets,
  normalizeSemanticTerms,
  rankCandidates,
} from "../server/search-core.mjs";
import {
  databaseErrorDetails,
  isDatabaseTimeout,
  runDatabaseQuery,
} from "../server/database.mjs";

const ALLOWED_MODES = new Set(["fuzzy", "exact", "broad", "semantic"]);

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
  if (mode === "semantic" && semanticTerms.length === 0) {
    return json({ error: "语义检索缺少有效的语义扩展词" }, 400);
  }

  const startedAt = Date.now();
  try {
    const { rows, terms } = await runDatabaseQuery(async (sql) => {
      if (mode === "exact") {
        const exactQuery = query.replace(/[%_\\]+/g, " ").replace(/\s+/g, " ").trim();
        if (!exactQuery) return { rows: [], terms: [] };
        return {
          terms: [exactQuery],
          rows: await sql`SELECT * FROM rag_search_exact(${exactQuery}, ${Math.max(100, topK * 20)})`,
        };
      }

      const searchTerms = mode === "semantic"
        ? buildSemanticSearchTerms(query, semanticTerms)
        : buildSearchTerms(query);
      if (searchTerms.length === 0) return { rows: [], terms: [] };
      const perTerm = Math.max(60, Math.min(140, topK * 12));
      const resultSets = await sql.transaction(
        searchTerms.map((term) => term.length <= 2
          ? sql`SELECT * FROM rag_search_short_term(${term}, ${perTerm})`
          : sql`SELECT * FROM rag_search_term(${term}, ${perTerm})`),
      );
      return { rows: mergeCandidateSets(resultSets), terms: searchTerms };
    }, 15000);

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

    return json({
      results,
      meta: {
        mode,
        terms,
        semanticTerms: mode === "semantic" ? semanticTerms : undefined,
        candidateCount: rows.length,
        elapsedMs: Date.now() - startedAt,
      },
    });
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
