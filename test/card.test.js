import { test } from "node:test";
import assert from "node:assert/strict";
import { cardBody, newDraft, pickDraft, problem, sourceLink } from "../src/lib/card.js";

const tab = { title: "Robins – Wikipedia", url: "https://en.wikipedia.org/wiki/Robin" };

test("a selection lands on the back, with the source below it", () => {
  const d = newDraft(tab, { selection: "  A small bird.  " });
  assert.equal(d.back, "A small bird.");
  d.front = "What is a robin?";
  assert.deepEqual(cardBody(d), {
    front: "What is a robin?",
    back: "A small bird.\n\nSource: [Robins – Wikipedia](https://en.wikipedia.org/wiki/Robin)",
  });
});

test("pages that aren't on the web get no source", () => {
  assert.equal(newDraft({ title: "New Tab", url: "about:newtab" }).source, undefined);
});

test("titles and URLs can't break the Markdown link", () => {
  assert.equal(
    sourceLink({ title: "[a] b\\", url: "https://x.org/a (b)" }),
    "Source: [\\[a\\] b\\\\](https://x.org/a%20%28b%29)",
  );
  assert.equal(sourceLink({ title: "", url: "https://x.org/p" }), "Source: [x.org](https://x.org/p)");
});

test("a card needs a front: text, or the image on the front", () => {
  const d = newDraft(tab, { selection: "x" });
  assert.equal(problem(d), "Write a front first.");
  d.front = "  ";
  assert.equal(problem(d), "Write a front first.");
  const img = newDraft(tab, { imageSrc: "https://x.org/robin.png" });
  assert.equal(problem(img), null);
  img.image = { src: "https://x.org/robin.png", side: "back" };
  assert.equal(problem(img), "Write a front first.");
});

test("the image id goes on the side the user picked", () => {
  const d = newDraft({}, { imageSrc: "https://x.org/robin.png" });
  assert.deepEqual(cardBody(d, "abc"), { front: "", back: "", front_image_id: "abc" });
  d.image = { src: "https://x.org/robin.png", side: "back" };
  d.front = "Which bird?";
  assert.deepEqual(cardBody(d, "abc"), { front: "Which bird?", back: "", back_image_id: "abc" });
});

test("a right-click draft always wins", () => {
  const fresh = { ...newDraft(tab, { selection: "from menu" }), fresh: true };
  assert.deepEqual(pickDraft(fresh, "something else", tab), { ...fresh, fresh: false });
});

test("a new selection starts over, no selection brings the draft back", () => {
  const saved = { ...newDraft(tab, { selection: "old" }), front: "half written" };
  assert.equal(pickDraft(saved, "new text", tab).back, "new text");
  assert.equal(pickDraft(saved, "", tab).front, "half written");
  assert.equal(pickDraft(saved, " old ", tab).front, "half written");
  assert.deepEqual(pickDraft(undefined, "", tab), newDraft(tab));
});
