// @ts-check
/**
 * Sign-in to an AiNKI server the way Claude connects: OAuth 2.1 with
 * dynamic client registration, PKCE (S256) and rotating refresh tokens.
 * The server stores the connection like any agent token, so it shows up
 * (and can be revoked) under Settings → Agent access.
 */

/**
 * @typedef {object} Session
 * @property {string} server     Origin of the AiNKI server.
 * @property {string} clientId
 * @property {string} access
 * @property {string} refresh
 * @property {number} expiresAt  Milliseconds since the epoch.
 */

/** @typedef {(input: string, init?: RequestInit) => Promise<Response>} Fetch */

export const CLIENT_NAME = "AiNKI for Firefox";

/** @param {Uint8Array} bytes */
export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 32 random bytes, base64url: 43 characters, the shortest PKCE verifier. */
export function randomString() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** @param {string} verifier */
export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * The origin of what the user typed: "cards.example.com/" becomes
 * "https://cards.example.com". Plain http only for the user's own machine.
 * @param {string} input
 */
export function normalizeServer(input) {
  const raw = input.trim();
  if (!raw) throw new Error("Enter your AiNKI address.");
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`"${raw}" is not a web address.`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("The address must start with https://.");
  }
  return url.origin;
}

/**
 * @param {string} server
 * @param {{clientId: string, redirectUri: string, challenge: string, state: string}} p
 */
export function authorizeUrl(server, p) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state,
  });
  return `${server}/oauth/authorize?${q}`;
}

/**
 * The code from the URL the server redirected to.
 * @param {string} url
 * @param {string} state  The state sent with the request.
 */
export function codeFromRedirect(url, state) {
  const q = new URL(url).searchParams;
  if (q.get("state") !== state) throw new Error("The sign-in answer did not match the request. Try again.");
  const error = q.get("error");
  if (error === "access_denied") throw new Error("You cancelled the connection.");
  if (error) throw new Error(q.get("error_description") || error);
  const code = q.get("code");
  if (!code) throw new Error("The server sent no authorization code.");
  return code;
}

/**
 * The error text of a failed response, from `{error_description}` or `{error}`.
 * @param {Response} res
 */
export async function errorText(res) {
  try {
    const body = await res.json();
    return body.error_description || body.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * @param {Fetch} fetchFn
 * @param {string} server
 * @param {string} redirectUri
 * @returns {Promise<string>} the client id
 */
export async function register(fetchFn, server, redirectUri) {
  const res = await fetchFn(`${server}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
  });
  if (!res.ok) throw new Error(`AiNKI refused to register the extension: ${await errorText(res)}`);
  return (await res.json()).client_id;
}

/**
 * Call the token endpoint and turn its answer into a session.
 * @param {Fetch} fetchFn
 * @param {string} server
 * @param {string} clientId
 * @param {Record<string, string>} form
 * @param {number} now
 * @returns {Promise<Session>}
 */
async function tokens(fetchFn, server, clientId, form, now) {
  const res = await fetchFn(`${server}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, ...form }).toString(),
  });
  if (!res.ok) throw new TokenError(await errorText(res), res.status);
  const t = await res.json();
  return { server, clientId, access: t.access_token, refresh: t.refresh_token, expiresAt: now + t.expires_in * 1000 };
}

/** The token endpoint said no: the connection is gone, sign in again. */
export class TokenError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Run the whole sign-in: register, let the user allow it, swap the code.
 * @param {object} p
 * @param {string} p.server  From {@link normalizeServer}.
 * @param {Fetch} p.fetchFn
 * @param {string} p.redirectUri  `browser.identity.getRedirectURL()`
 * @param {(url: string) => Promise<string>} p.authorize  Opens the page, resolves to the redirect URL.
 * @param {() => number} [p.now]
 * @returns {Promise<Session>}
 */
export async function connect({ server, fetchFn, redirectUri, authorize, now = Date.now }) {
  const clientId = await register(fetchFn, server, redirectUri);
  const verifier = randomString();
  const state = randomString();
  const challenge = await pkceChallenge(verifier);
  const back = await authorize(authorizeUrl(server, { clientId, redirectUri, challenge, state }));
  const code = codeFromRedirect(back, state);
  return tokens(
    fetchFn,
    server,
    clientId,
    { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri },
    now(),
  );
}

/**
 * Swap the refresh token for new ones (the old one stops working).
 * @param {Fetch} fetchFn
 * @param {Session} s
 * @param {number} now
 */
export function refresh(fetchFn, s, now) {
  return tokens(fetchFn, s.server, s.clientId, { grant_type: "refresh_token", refresh_token: s.refresh }, now);
}

/**
 * End the connection on the server. Best effort: the session is dropped
 * locally either way.
 * @param {Fetch} fetchFn
 * @param {Session} s
 */
export async function revoke(fetchFn, s) {
  try {
    await fetchFn(`${s.server}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: s.clientId, token: s.refresh }).toString(),
    });
  } catch {
    // Offline: the refresh token expires on its own after 90 days.
  }
}
