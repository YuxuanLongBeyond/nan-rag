import {
  databaseErrorDetails,
  isDatabaseTimeout,
  runDatabaseQuery,
} from "../server/database.mjs";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "private, max-age=300",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function serializeChunk(row) {
  return {
    id: row.id,
    work: row.work,
    chapter: row.chapter,
    text: row.content || "",
    charCount: Number(row.char_count) || String(row.content || "").length,
  };
}

export async function contextHandler(request) {
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

  const id = String(input?.id || "").trim();
  const direction = ["around", "before", "after"].includes(input?.direction)
    ? input.direction
    : "around";
  const limit = Math.max(1, Math.min(4, Math.trunc(Number(input?.limit) || 2)));
  if (!id || id.length > 300) return json({ error: "片段编号无效" }, 400);

  const startedAt = Date.now();
  try {
    const result = await runDatabaseQuery(async (sql) => {
      const anchors = await sql`
        SELECT id, index_pos, work, chapter
        FROM rag_chunks
        WHERE id = ${id}
        LIMIT 1
      `;
      const anchor = anchors[0];
      if (!anchor) return null;

      let beforeRows = [];
      let afterRows = [];
      const take = limit + 1;
      const requests = [];
      if (direction !== "after") {
        requests.push(sql`
          SELECT id, index_pos, work, chapter, content, char_count
          FROM rag_chunks
          WHERE work = ${anchor.work}
            AND chapter = ${anchor.chapter}
            AND index_pos < ${anchor.index_pos}
          ORDER BY index_pos DESC
          LIMIT ${take}
        `);
      }
      if (direction !== "before") {
        requests.push(sql`
          SELECT id, index_pos, work, chapter, content, char_count
          FROM rag_chunks
          WHERE work = ${anchor.work}
            AND chapter = ${anchor.chapter}
            AND index_pos > ${anchor.index_pos}
          ORDER BY index_pos ASC
          LIMIT ${take}
        `);
      }
      const responses = requests.length > 1
        ? await sql.transaction(requests)
        : [await requests[0]];
      if (direction === "around") [beforeRows, afterRows] = responses;
      else if (direction === "before") [beforeRows] = responses;
      else [afterRows] = responses;

      const hasBefore = beforeRows.length > limit;
      const hasAfter = afterRows.length > limit;
      return {
        work: anchor.work,
        chapter: anchor.chapter,
        before: beforeRows.slice(0, limit).reverse().map(serializeChunk),
        after: afterRows.slice(0, limit).map(serializeChunk),
        hasBefore,
        hasAfter,
      };
    }, 10000);

    if (!result) return json({ error: "未找到该原文片段" }, 404);
    return json(result);
  } catch (error) {
    const details = databaseErrorDetails(error, startedAt);
    console.error("RAG context failed", details);
    return json({
      code: details.code,
      error: isDatabaseTimeout(error)
        ? "上下文加载超时，请稍后重试"
        : "上下文暂时无法加载，请稍后重试",
    }, 503);
  }
}

export default { fetch: contextHandler };
