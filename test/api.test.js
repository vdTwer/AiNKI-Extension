import { test } from "node:test";
import assert from "node:assert/strict";
import { Api, NotConnected } from "../src/lib/api.js";

const session = { server: "https://c.org", clientId: "cid", access: "at1", refresh: "rt1", expiresAt: 10_000_000 };

function memoryStore(initial) {
  let s = initial;
  return { load: async () => s, save: async (n) => void (s = n), clear: async () => void (s = undefined), peek: () => s };
}

function fake(handler) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, ...init });
    const [status, body] = handler(new URL(url).pathname, init);
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  };
  return { calls, fetchFn };
}

const tokenOk = [200, { access_token: "at2", refresh_token: "rt2", expires_in: 3600 }];

test("calls send the access token", async () => {
  const { calls, fetchFn } = fake(() => [200, [{ id: 1, name: "Birds" }]]);
  const api = new Api({ store: memoryStore(session), fetchFn, now: () => 0 });
  assert.deepEqual(await api.decks(), [{ id: 1, name: "Birds" }]);
  assert.equal(calls[0].url, "https://c.org/api/v1/decks");
  assert.equal(calls[0].headers.Authorization, "Bearer at1");
});

test("an expiring token is refreshed first and the new session saved", async () => {
  const store = memoryStore({ ...session, expiresAt: 30_000 });
  const { calls, fetchFn } = fake((path) => (path === "/oauth/token" ? tokenOk : [201, { id: 7 }]));
  const api = new Api({ store, fetchFn, now: () => 0 });
  assert.deepEqual(await api.createCard(3, { front: "f", back: "b" }), { id: 7 });
  assert.equal(new URLSearchParams(calls[0].body).get("refresh_token"), "rt1");
  assert.equal(calls[1].url, "https://c.org/api/v1/decks/3/cards");
  assert.equal(calls[1].headers.Authorization, "Bearer at2");
  assert.deepEqual(JSON.parse(calls[1].body), { front: "f", back: "b" });
  assert.equal(store.peek().refresh, "rt2");
});

test("a 401 refreshes once and retries", async () => {
  let first = true;
  const { calls, fetchFn } = fake((path) => {
    if (path === "/oauth/token") return tokenOk;
    if (first) return (first = false), [401, { error: "missing or invalid token" }];
    return [200, []];
  });
  const api = new Api({ store: memoryStore(session), fetchFn, now: () => 0 });
  assert.deepEqual(await api.decks(), []);
  assert.equal(calls.length, 3);
});

test("a revoked connection clears the session", async () => {
  const store = memoryStore({ ...session, expiresAt: 0 });
  const { fetchFn } = fake(() => [400, { error: "invalid_grant" }]);
  const api = new Api({ store, fetchFn, now: () => 0 });
  await assert.rejects(api.decks(), (e) => e instanceof NotConnected && /ended/.test(e.message));
  assert.equal(store.peek(), undefined);
});

test("no session means not connected", async () => {
  const api = new Api({ store: memoryStore(undefined), fetchFn: fake(() => [200, []]).fetchFn });
  await assert.rejects(api.decks(), NotConnected);
});

test("API errors reach the user in words", async () => {
  const { fetchFn } = fake(() => [403, { error: "forbidden: this token can't write" }]);
  const api = new Api({ store: memoryStore(session), fetchFn, now: () => 0 });
  await assert.rejects(api.createCard(1, { front: "f", back: "" }), /Forbidden: this token can't write\. Connect again/);
  const down = new Api({ store: memoryStore(session), fetchFn: async () => new Response("<html>", { status: 502 }), now: () => 0 });
  await assert.rejects(down.decks(), /AiNKI answered 502/);
});

test("images go up as raw bytes with their type", async () => {
  const { calls, fetchFn } = fake(() => [201, { image_id: "img1" }]);
  const api = new Api({ store: memoryStore(session), fetchFn, now: () => 0 });
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
  assert.deepEqual(await api.uploadImage(blob), { image_id: "img1" });
  assert.equal(calls[0].url, "https://c.org/api/v1/images");
  assert.equal(calls[0].headers["Content-Type"], "image/jpeg");
  assert.equal(calls[0].body, blob);
});
