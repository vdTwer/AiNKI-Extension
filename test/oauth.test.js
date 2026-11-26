import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeUrl,
  codeFromRedirect,
  connect,
  normalizeServer,
  pkceChallenge,
  randomString,
  refresh,
  TokenError,
} from "../src/lib/oauth.js";

test("PKCE challenge is unpadded base64url SHA-256", async () => {
  // Expected value from Python: urlsafe_b64encode(sha256(verifier)) without "=".
  assert.equal(
    await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r7wW1gFWFOEjXk"),
    "bwWFMyPfdG9qreDhH2lmftFx_dFeLDalzcT1gb_j68g",
  );
});

test("random strings are valid PKCE verifiers", () => {
  const v = randomString();
  assert.match(v, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(v, randomString());
});

test("server addresses are cleaned up to an origin", () => {
  assert.equal(normalizeServer(" cards.example.com/ "), "https://cards.example.com");
  assert.equal(normalizeServer("https://cards.example.com/home"), "https://cards.example.com");
  assert.equal(normalizeServer("http://localhost:8080"), "http://localhost:8080");
  assert.throws(() => normalizeServer("http://cards.example.com"), /https/);
  assert.throws(() => normalizeServer(""), /Enter/);
  assert.throws(() => normalizeServer("ftp://x.org"), /https/);
});

test("the authorize URL carries PKCE and state", () => {
  const u = new URL(
    authorizeUrl("https://c.org", { clientId: "id", redirectUri: "https://r.org/", challenge: "ch", state: "st" }),
  );
  assert.equal(u.pathname, "/oauth/authorize");
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    response_type: "code",
    client_id: "id",
    redirect_uri: "https://r.org/",
    code_challenge: "ch",
    code_challenge_method: "S256",
    state: "st",
  });
});

test("redirects are checked before their code is used", () => {
  assert.equal(codeFromRedirect("https://r.org/?code=c1&state=s", "s"), "c1");
  assert.throws(() => codeFromRedirect("https://r.org/?code=c1&state=evil", "s"), /did not match/);
  assert.throws(() => codeFromRedirect("https://r.org/?error=access_denied&state=s", "s"), /cancelled/);
  assert.throws(() => codeFromRedirect("https://r.org/?state=s", "s"), /no authorization code/);
});

/** A fake AiNKI that records calls. */
function fakeServer(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, ...init });
    const path = new URL(url).pathname;
    const [status, body] = routes[path](init);
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchFn };
}

test("connect registers, asks the user and swaps the code with the verifier", async () => {
  let sentUrl;
  const { calls, fetchFn } = fakeServer({
    "/oauth/register": () => [201, { client_id: "cid" }],
    "/oauth/token": () => [200, { access_token: "at", refresh_token: "rt", expires_in: 3600 }],
  });
  const s = await connect({
    server: "https://c.org",
    fetchFn,
    redirectUri: "https://ext.extensions.allizom.org/",
    authorize: async (url) => {
      sentUrl = new URL(url);
      return `https://ext.extensions.allizom.org/?code=thecode&state=${sentUrl.searchParams.get("state")}`;
    },
    now: () => 1000,
  });
  assert.deepEqual(s, { server: "https://c.org", clientId: "cid", access: "at", refresh: "rt", expiresAt: 3_601_000 });
  assert.deepEqual(JSON.parse(calls[0].body).redirect_uris, ["https://ext.extensions.allizom.org/"]);
  const form = new URLSearchParams(calls[1].body);
  assert.equal(form.get("code"), "thecode");
  assert.equal(form.get("client_id"), "cid");
  assert.equal(await pkceChallenge(form.get("code_verifier")), sentUrl.searchParams.get("code_challenge"));
});

test("a refused refresh is a TokenError with the server's reason", async () => {
  const { fetchFn } = fakeServer({
    "/oauth/token": () => [400, { error: "invalid_grant", error_description: "invalid or expired refresh token" }],
  });
  const s = { server: "https://c.org", clientId: "cid", access: "a", refresh: "r", expiresAt: 0 };
  await assert.rejects(refresh(fetchFn, s, 0), (e) => e instanceof TokenError && e.status === 400 && /expired/.test(e.message));
});
