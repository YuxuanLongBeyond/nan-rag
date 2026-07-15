import test from "node:test";
import assert from "node:assert/strict";
import healthFunction, { healthHandler } from "../api/health.mjs";
import searchFunction, { searchHandler } from "../api/search.mjs";
import { databaseErrorCode } from "../server/database.mjs";

async function withoutDatabase(callback) {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

test("API 使用 Vercel Web Handler 导出格式", () => {
  assert.equal(healthFunction.fetch, healthHandler);
  assert.equal(searchFunction.fetch, searchHandler);
});

test("数据库错误只暴露安全分类，不需要返回连接串", () => {
  assert.equal(
    databaseErrorCode(new Error("This connection is trying to access this endpoint from a blocked network.")),
    "NETWORK_BLOCKED",
  );
  assert.equal(
    databaseErrorCode(new Error("password authentication failed for user")),
    "AUTHENTICATION_FAILED",
  );
});

test("健康接口在未配置数据库时明确返回 503", async () => {
  await withoutDatabase(async () => {
    const response = await healthHandler();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).ready, false);
  });
});

test("搜索接口拒绝非 POST 请求", async () => {
  const response = await searchHandler(new Request("https://example.test/api/search"));
  assert.equal(response.status, 405);
});

test("搜索接口要求先确认版权声明", async () => {
  const response = await searchHandler(new Request("https://example.test/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "安那般那" }),
  }));
  assert.equal(response.status, 403);
});

test("搜索接口未配置数据库时不泄漏内部信息", async () => {
  await withoutDatabase(async () => {
    const response = await searchHandler(new Request("https://example.test/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Copyright-Accepted": "1",
      },
      body: JSON.stringify({ query: "安那般那" }),
    }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "服务端数据库尚未配置");
  });
});

test("语义模式不会在缺少语义扩展时静默降级为宽泛搜索", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://unused.invalid/test";
  try {
    const response = await searchHandler(new Request("https://example.test/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Copyright-Accepted": "1",
      },
      body: JSON.stringify({ query: "心里很乱怎么办", mode: "semantic" }),
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "语义检索缺少有效的语义扩展词");
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
