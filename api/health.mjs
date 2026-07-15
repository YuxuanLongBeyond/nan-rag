import {
  databaseErrorDetails,
  isDatabaseTimeout,
  runDatabaseQuery,
} from "../server/database.mjs";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function healthHandler() {
  if (!process.env.DATABASE_URL) {
    return json({ ready: false, error: "DATABASE_URL 尚未配置" }, 503);
  }

  const startedAt = Date.now();
  try {
    const [meta] = await runDatabaseQuery((sql) => sql`
        SELECT value
        FROM rag_meta
        WHERE key = 'corpus'
        LIMIT 1
      `, 7000);
    if (!meta?.value?.chunks) {
      return json({ ready: false, error: "数据库尚未导入语料" }, 503);
    }
    return json({ ready: true, ...meta.value });
  } catch (error) {
    const details = databaseErrorDetails(error, startedAt);
    console.error("RAG health check failed", details);
    const timedOut = isDatabaseTimeout(error);
    return json({
      ready: false,
      code: timedOut ? "DATABASE_TIMEOUT" : "DATABASE_UNAVAILABLE",
      error: timedOut ? "数据库连接超时" : "数据库连接或结构不可用",
      diagnostics: {
        elapsedMs: details.elapsedMs,
        region: details.region,
        nodeVersion: details.nodeVersion,
        pooled: details.pooled,
      },
    }, 503);
  }
}

// Vercel Web Handler 格式：返回 Web Response 时必须通过 fetch 导出。
export default { fetch: healthHandler };
