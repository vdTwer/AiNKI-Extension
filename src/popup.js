// @ts-check
/**
 * The add-card popup. It opens from the toolbar, the shortcut or a
 * right-click, and creates a card only on "Add card" or Ctrl+Enter.
 */
import { Api, NotConnected, storageStore } from "./lib/api.js";
import { cardBody, pickDraft, problem } from "./lib/card.js";

/** @typedef {import("./lib/card.js").Draft} Draft */

/** @param {string} id */
const $ = (id) => /** @type {any} */ (document.getElementById(id));

const api = new Api({ store: storageStore(browser.storage.local), fetchFn: (u, i) => fetch(u, i) });

/** @type {Draft} */
let draft;
let busy = false;

/**
 * @param {string} text
 * @param {"" | "ok" | "error"} [kind]
 */
function status(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

/** @param {string} [why] */
function showConnect(why) {
  $("card").hidden = true;
  $("connect").hidden = false;
  if (why) $("connect-why").textContent = why;
}

/** What is selected in the tab, or "" where scripts can't run (about: pages). */
async function selectionIn(/** @type {number | undefined} */ tabId) {
  if (tabId === undefined) return "";
  try {
    const [r] = await browser.scripting.executeScript({ target: { tabId }, func: () => String(getSelection() ?? "") });
    return typeof r?.result === "string" ? r.result : "";
  } catch {
    return "";
  }
}

function keep() {
  browser.storage.session.set({ draft });
}

function render() {
  $("front").value = draft.front;
  $("back").value = draft.back;
  $("image").hidden = !draft.image;
  if (draft.image) {
    $("image-preview").src = draft.image.src;
    for (const r of document.querySelectorAll('input[name="side"]')) {
      /** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === draft.image.side;
    }
  }
  $("source").hidden = !draft.source;
  if (draft.source) $("source").textContent = `Source: ${draft.source.title || draft.source.url}`;
}

async function loadDecks() {
  const decks = await api.decks();
  if (!decks.length) {
    status("Make a deck in AiNKI first.", "error");
    $("add").disabled = true;
    return;
  }
  const { lastDeck } = await browser.storage.local.get("lastDeck");
  $("deck").replaceChildren(
    ...decks.map((d) => Object.assign(document.createElement("option"), { value: String(d.id), textContent: d.name })),
  );
  if (decks.some((d) => d.id === lastDeck)) $("deck").value = String(lastDeck);
}

/** @param {string} src */
async function imageBlob(src) {
  let res;
  try {
    res = await fetch(src, { credentials: "include" });
  } catch (e) {
    throw new Error(`Could not load the image: ${/** @type {Error} */ (e).message}`);
  }
  if (!res.ok) throw new Error(`Could not load the image (HTTP ${res.status}).`);
  return uploadable(await res.blob());
}

/** AiNKI reads PNG, JPEG, GIF and WebP. Anything else (SVG, AVIF) is redrawn as a PNG. */
const READABLE = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** @param {Blob} blob */
async function uploadable(blob) {
  if (READABLE.includes(blob.type)) return blob;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || 1200;
    canvas.height = img.naturalHeight || 800;
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("empty");
    return /** @type {Blob} */ (png);
  } catch {
    throw new Error("This picture's format can't be read. Try another image.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function save() {
  if (busy) return;
  const why = problem(draft);
  if (why) {
    status(why, "error");
    $("front").focus();
    return;
  }
  const deckId = Number($("deck").value);
  const deckName = $("deck").selectedOptions[0]?.textContent ?? "";
  busy = true;
  $("add").disabled = true;
  status("Adding…");
  try {
    const imageId = draft.image ? (await api.uploadImage(await imageBlob(draft.image.src))).image_id : undefined;
    await api.createCard(deckId, cardBody(draft, imageId));
    await browser.storage.local.set({ lastDeck: deckId });
    await browser.storage.session.remove("draft");
    status(`Added to ${deckName}.`, "ok");
    setTimeout(() => window.close(), 1200);
  } catch (e) {
    // The draft stays saved, so nothing typed is lost.
    if (e instanceof NotConnected) showConnect(e.message);
    else status(/** @type {Error} */ (e).message, "error");
    busy = false;
    $("add").disabled = false;
  }
}

function wire() {
  $("front").addEventListener("input", () => ((draft.front = $("front").value), keep()));
  $("back").addEventListener("input", () => ((draft.back = $("back").value), keep()));
  for (const r of document.querySelectorAll('input[name="side"]')) {
    r.addEventListener("change", (e) => {
      if (draft.image) draft.image.side = /** @type {HTMLInputElement} */ (e.target).value === "back" ? "back" : "front";
      keep();
    });
  }
  $("image-remove").addEventListener("click", () => {
    delete draft.image;
    keep();
    render();
  });
  $("card").addEventListener("submit", (/** @type {Event} */ e) => {
    e.preventDefault();
    save();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  });
  $("open-options").addEventListener("click", () => {
    browser.runtime.openOptionsPage();
    window.close();
  });
}

async function main() {
  wire();
  const { session } = await browser.storage.local.get("session");
  if (!session) return showConnect();
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const pending = await browser.runtime.sendMessage("take-pending");
  const { draft: saved } = await browser.storage.session.get("draft");
  draft = pickDraft(pending ?? saved, pending ? "" : await selectionIn(tab?.id), tab ?? {});
  keep();
  render();
  $("card").hidden = false;
  $("front").focus();
  try {
    await loadDecks();
  } catch (e) {
    if (e instanceof NotConnected) showConnect(e.message);
    else status(`Could not load your decks: ${/** @type {Error} */ (e).message}`, "error");
  }
}

main().catch((e) => {
  $("card").hidden = false;
  status(String(e?.message ?? e), "error");
});
