import assert from "node:assert/strict";
import { test } from "node:test";
import customer from "../api/customer.js";

const account = "11111111-1111-4111-8111-111111111111";
const browser = "22222222-2222-4222-8222-222222222222";
const origin = "https://seoul-ai-hackathon.vercel.app";

async function request(body, headers = {}) {
  const result = { headers: {} };
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(status) { result.status = status; return this; },
    json(body) { result.body = body; return this; },
  };
  await customer({
    method: "POST",
    headers: { host: new URL(origin).host, origin, "content-type": "application/json", ...headers },
    body,
  }, response);
  return result;
}

test("customer writes require a session and reject cross-origin requests", async t => {
  const upstream = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected upstream call"); });
  const order = { action: "place", account, browser_key: browser, payload: {} };
  assert.equal((await request(order)).status, 401);
  assert.equal((await request(order, { origin: "https://another.example" })).status, 403);
  assert.equal(upstream.mock.callCount(), 0);
});

test("login returns a profile and stores tokens only in protected cookies", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    access_token: "auth-token", refresh_token: "refresh-token", expires_in: 3600,
    user: { id: account, email: "customer@example.test", user_metadata: { name: "Tester" } },
  }));
  const result = await request({ action: "login", email: "customer@example.test", password: "test-only-password" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { account: { id: account, email: "customer@example.test", name: "Tester" } });
  assert.equal(result.headers["Set-Cookie"].length, 2);
  for (const cookie of result.headers["Set-Cookie"]) {
    assert.match(cookie, /^__Host-/);
    assert.match(cookie, /Path=\/; HttpOnly; Secure; SameSite=Lax/);
  }
});

test("a refreshed request carries the authenticated token and the expected account", async t => {
  const upstream = t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("grant_type=refresh_token")) {
      assert.deepEqual(JSON.parse(options.body), { refresh_token: "old-refresh" });
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    }
    assert.match(url, /\/rpc\/seoul_delivery_demo$/);
    assert.equal(options.headers.Authorization, "Bearer new-access");
    assert.deepEqual(JSON.parse(options.body), {
      action: "customer_orders", browser_key: browser, payload: { expected_customer: account },
    });
    return Response.json([]);
  });
  const result = await request(
    { action: "customer_orders", account, browser_key: browser, payload: { expected_customer: "wrong" } },
    { cookie: "__Host-bappilot-refresh=old-refresh" },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, []);
  assert.equal(upstream.mock.callCount(), 2);
  assert.match(result.headers["Set-Cookie"][0], /new-access/);
});
