// @ts-check
/** Connect to (or disconnect from) an AiNKI server. */
import { connect, normalizeServer, revoke } from "./lib/oauth.js";

/** @param {string} id */
const $ = (id) => /** @type {any} */ (document.getElementById(id));

/**
 * @param {string} text
 * @param {"" | "ok" | "error"} [kind]
 */
function status(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

async function render() {
  const { session, server } = await browser.storage.local.get(["session", "server"]);
  $("connect").hidden = Boolean(session);
  $("connected").hidden = !session;
  if (session) $("server-name").textContent = session.server;
  else if (server) $("server").value = server;
  const command = (await browser.commands.getAll()).find((c) => c.name === "_execute_action");
  if (command?.shortcut) $("shortcut").textContent = command.shortcut;
}

$("connect").addEventListener("submit", async (/** @type {Event} */ e) => {
  e.preventDefault();
  try {
    const server = normalizeServer($("server").value);
    await browser.storage.local.set({ server });
    status("Allow the extension in the AiNKI window that just opened…");
    const session = await connect({
      server,
      fetchFn: (u, i) => fetch(u, i),
      redirectUri: browser.identity.getRedirectURL(),
      authorize: (url) => browser.identity.launchWebAuthFlow({ url, interactive: true }),
    });
    await browser.storage.local.set({ session });
    status("Connected.", "ok");
  } catch (err) {
    status(/** @type {Error} */ (err).message, "error");
  }
  render();
});

$("disconnect").addEventListener("click", async () => {
  const { session } = await browser.storage.local.get("session");
  if (session) await revoke((u, i) => fetch(u, i), session);
  await browser.storage.local.remove("session");
  status("Disconnected.");
  render();
});

render();
