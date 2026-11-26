// @ts-check
/**
 * What the popup edits, and the card it becomes. Pure functions, so the
 * rules are tested without a browser.
 */

/**
 * @typedef {object} Draft
 * @property {string} front
 * @property {string} back
 * @property {string} [selection]  The page text it started from.
 * @property {{src: string, side: "front" | "back"}} [image]
 * @property {{title: string, url: string}} [source]
 * @property {boolean} [fresh]  Just made from a right-click; beats a saved draft.
 */

/**
 * @typedef {object} CardBody
 * @property {string} front
 * @property {string} back
 * @property {string} [front_image_id]
 * @property {string} [back_image_id]
 */

/**
 * A new draft from a page.
 * @param {{title?: string, url?: string}} tab
 * @param {{selection?: string, imageSrc?: string}} [from]
 * @returns {Draft}
 */
export function newDraft(tab, from = {}) {
  const selection = (from.selection ?? "").trim();
  /** @type {Draft} */
  const d = { front: "", back: selection, selection };
  if (from.imageSrc) d.image = { src: from.imageSrc, side: "front" };
  if (tab.url && /^https?:/.test(tab.url)) d.source = { title: (tab.title ?? "").trim(), url: tab.url };
  return d;
}

/**
 * Which draft the popup opens with. A right-click always wins. Otherwise a
 * new selection starts a new draft, and without one the unsaved draft
 * comes back (the popup closes when it loses focus, so nothing is lost).
 * @param {Draft | undefined} saved
 * @param {string} selection  What is selected on the page now.
 * @param {{title?: string, url?: string}} tab
 * @returns {Draft}
 */
export function pickDraft(saved, selection, tab) {
  if (saved?.fresh) return { ...saved, fresh: false };
  const sel = selection.trim();
  if (sel && sel !== saved?.selection) return newDraft(tab, { selection: sel });
  return saved ?? newDraft(tab);
}

/**
 * The source as a Markdown link, kept at the end of the back.
 * @param {{title: string, url: string}} source
 */
export function sourceLink(source) {
  const title = (source.title || new URL(source.url).hostname).replace(/[[\]\\]/g, "\\$&");
  const url = source.url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()}`);
  return `Source: [${title}](${url})`;
}

/**
 * Why the draft can't be saved yet, or null.
 * @param {Draft} d
 */
export function problem(d) {
  if (!d.front.trim() && d.image?.side !== "front") return "Write a front first.";
  return null;
}

/**
 * The request body for POST /decks/{id}/cards.
 * @param {Draft} d
 * @param {string} [imageId]  The uploaded image, if the draft has one.
 * @returns {CardBody}
 */
export function cardBody(d, imageId) {
  const back = [d.back.trim(), d.source ? sourceLink(d.source) : ""].filter(Boolean).join("\n\n");
  /** @type {CardBody} */
  const body = { front: d.front.trim(), back };
  if (imageId && d.image) body[d.image.side === "front" ? "front_image_id" : "back_image_id"] = imageId;
  return body;
}
