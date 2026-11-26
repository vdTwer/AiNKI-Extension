// @ts-check
/**
 * The AiNKI REST API (/api/v1), with the OAuth session kept fresh.
 */
import { refresh, TokenError } from "./oauth.js";

/** @typedef {import("./oauth.js").Session} Session */
/** @typedef {import("./oauth.js").Fetch} Fetch */

/**
 * Where the session lives: `browser.storage.local` in the extension, a map
 * in tests.
 * @typedef {object} SessionStore
 * @property {() => Promise<Session | undefined>} load
 * @property {(s: Session) => Promise<void>} save
 * @property {() => Promise<void>} clear
 */

/** The user has to connect (again) on the options page. */
export class NotConnected extends Error {
  constructor(message = "Connect the extension to AiNKI first.") {
    super(message);
  }
}

/** Refresh this long before the access token runs out. */
const MARGIN_MS = 60_000;

export class Api {
  /**
   * @param {object} p
   * @param {SessionStore} p.store
   * @param {Fetch} p.fetchFn
   * @param {() => number} [p.now]
   */
  constructor({ store, fetchFn, now = Date.now }) {
    this.store = store;
    this.fetchFn = fetchFn;
    this.now = now;
  }

  /** @returns {Promise<Session>} */
  async session() {
    const s = await this.store.load();
    if (!s) throw new NotConnected();
    return s;
  }

  /**
   * A session with a usable access token, refreshed if it is (nearly) out.
   * @param {boolean} [force]  Refresh even if it looks valid.
   */
  async fresh(force = false) {
    const s = await this.session();
    if (!force && s.expiresAt - MARGIN_MS > this.now()) return s;
    try {
      const next = await refresh(this.fetchFn, s, this.now());
      await this.store.save(next);
      return next;
    } catch (e) {
      if (e instanceof TokenError && e.status < 500) {
        // Revoked under Agent access, or unused for 90 days.
        await this.store.clear();
        throw new NotConnected("The connection to AiNKI ended. Connect again.");
      }
      throw e;
    }
  }

  /**
   * @param {string} method
   * @param {string} path  Below /api/v1.
   * @param {{json?: unknown, blob?: Blob}} [body]
   */
  async call(method, path, body = {}) {
    /** @param {Session} s */
    const send = (s) => {
      /** @type {Record<string, string>} */
      const headers = { Authorization: `Bearer ${s.access}` };
      /** @type {BodyInit | undefined} */
      let payload;
      if (body.json !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body.json);
      } else if (body.blob) {
        headers["Content-Type"] = body.blob.type || "application/octet-stream";
        payload = body.blob;
      }
      return this.fetchFn(`${s.server}/api/v1${path}`, { method, headers, body: payload });
    };
    let res = await send(await this.fresh());
    // The token can end early (server restart, clock skew): retry once.
    if (res.status === 401) res = await send(await this.fresh(true));
    if (!res.ok) {
      let msg = `AiNKI answered ${res.status}.`;
      try {
        const e = await res.json();
        if (e.error) msg = e.error.charAt(0).toUpperCase() + e.error.slice(1);
      } catch {
        // Not JSON (a proxy's error page): keep the status.
      }
      throw new Error(res.status === 403 ? `${msg}. Connect again and allow it to add cards.` : msg);
    }
    return res.json();
  }

  /** @returns {Promise<{id: number, name: string}[]>} */
  decks() {
    return this.call("GET", "/decks");
  }

  /**
   * @param {number} deckId
   * @param {import("./card.js").CardBody} card
   */
  createCard(deckId, card) {
    return this.call("POST", `/decks/${deckId}/cards`, { json: card });
  }

  /**
   * @param {Blob} blob
   * @returns {Promise<{image_id: string}>}
   */
  uploadImage(blob) {
    return this.call("POST", "/images", { blob });
  }
}

/**
 * A session store on `browser.storage.local`.
 * @param {typeof browser.storage.local} area
 * @returns {SessionStore}
 */
export function storageStore(area) {
  return {
    load: async () => (await area.get("session")).session,
    save: (s) => area.set({ session: s }),
    clear: () => area.remove("session"),
  };
}
