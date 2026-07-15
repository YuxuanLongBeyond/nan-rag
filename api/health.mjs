import { neon } from "@neondatabase/serverless";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export default async function handler() {
  if (!process.env.DATABASE_URL) {
    return json({ ready: false, error: "DATABASE_URL 尚未配置" }, 503);
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    const [meta] = await sql`
      SELECT value
      FROM rag_meta
      WHERE key = 'corpus'
      LIMIT 1
    `;
    if (!meta?.value?.chunks) {
      return json({ ready: false, error: "数据库尚未导入语料" }, 503);
    }
    return json({ ready: true, ...meta.value });
  } catch (error) {
    console.error("RAG health check failed", error);
    return json({ ready: false, error: "数据库连接或结构不可用" }, 503);
  }
}
