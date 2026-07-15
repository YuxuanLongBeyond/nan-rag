import { neon } from "@neondatabase/serverless";
import {
  buildSearchTerms,
  mergeCandidateSets,
  rankCandidates,
} from "../server/search-core.mjs";

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

export default async function handler(request) {
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

  const startedAt = Date.now();
  try {
    const sql = neon(process.env.DATABASE_URL);
    let rows;
    let terms;
    if (mode === "exact") {
      const exactQuery = query.replace(/[%_\\]+/g, " ").replace(/\s+/g, " ").trim();
      if (!exactQuery) return json({ results: [], meta: { mode, candidateCount: 0 } });
      terms = [exactQuery];
      rows = await sql`SELECT * FROM rag_search_exact(${exactQuery}, ${Math.max(100, topK * 20)})`;
    } else {
      terms = buildSearchTerms(query);
      if (terms.length === 0) return json({ results: [], meta: { mode, candidateCount: 0 } });
      const perTerm = Math.max(60, Math.min(140, topK * 12));
      const resultSets = await sql.transaction(
        terms.map((term) => sql`SELECT * FROM rag_search_term(${term}, ${perTerm})`),
      );
      rows = mergeCandidateSets(resultSets);
    }

    const ranked = rankCandidates(rows, query, mode, topK, minScore);
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
        mode: mode === "semantic" ? "broad" : mode,
        terms,
        candidateCount: rows.length,
        elapsedMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    console.error("RAG search failed", error);
    return json({ error: "检索服务暂时不可用，请稍后重试" }, 503);
  }
}
