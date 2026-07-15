import test from "node:test";
import assert from "node:assert/strict";
import healthHandler from "../api/health.mjs";
import searchHandler from "../api/search.mjs";

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
