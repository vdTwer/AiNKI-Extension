// @ts-check
/**
 * Right-click menus. A click makes a draft and opens the popup with it;
 * the card is only created when the user saves there.
 */
import { newDraft } from "./lib/card.js";

/** @type {import("./lib/card.js").Draft | undefined} */
let pending;

browser.runtime.onInstalled.addListener(({ reason }) => {
  browser.menus.create({ id: "selection", title: "Add selection to AiNKI", contexts: ["selection"] });
  browser.menus.create({ id: "image", title: "Add image to AiNKI", contexts: ["image"] });
  if (reason === "install") browser.runtime.openOptionsPage();
});

browser.menus.onClicked.addListener((info, tab) => {
  const page = { title: tab?.title, url: info.pageUrl ?? tab?.url };
  pending =
    info.menuItemId === "image"
      ? { ...newDraft(page, { imageSrc: info.srcUrl }), fresh: true }
      : { ...newDraft(page, { selection: info.selectionText }), fresh: true };
  // Must run in the click's own turn: Firefox opens popups only for user actions.
  browser.action.openPopup();
});

// The popup asks once for the draft a right-click made.
browser.runtime.onMessage.addListener((msg) => {
  if (msg !== "take-pending") return undefined;
  const d = pending;
  pending = undefined;
  return Promise.resolve(d ?? null);
});
