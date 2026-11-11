// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { editDistance, localParts, madeOwn, nextSlots, weekdayOf, zonedToUtc } from "../src/lib.ts";
import { textToBodyJson } from "../src/substack.ts";

const ROME = "Europe/Rome";

test("a wall-clock time in Rome converts to the right instant, in winter and in summer", () => {
  assert.equal(new Date(zonedToUtc(2026, 11, 12, 9, 0, ROME)).toISOString(), "2026-11-12T08:00:00.000Z");
  assert.equal(new Date(zonedToUtc(2026, 7, 1, 9, 0, ROME)).toISOString(), "2026-07-01T07:00:00.000Z");
});

test("a time on the day the clocks change still lands on the same wall-clock time", () => {
  // 2026-03-29: clocks go forward in Italy. 18:30 that day is already summer time.
  const t = zonedToUtc(2026, 3, 29, 18, 30, ROME);
  const p = localParts(t, ROME);
  assert.deepEqual([p.d, p.h, p.min], [29, 18, 30]);
});

test("weekdays are numbered Monday 1 to Sunday 7 in the app's timezone", () => {
  assert.equal(weekdayOf(zonedToUtc(2026, 11, 11, 12, 0, ROME), ROME), 3); // a Wednesday
  assert.equal(weekdayOf(zonedToUtc(2026, 11, 15, 23, 30, ROME), ROME), 7); // late Sunday evening
});

test("the next free slots skip taken times, past times and switched-off days", () => {
  const from = zonedToUtc(2026, 11, 11, 10, 0, ROME); // Wednesday 10:00
  const slots = ["09:00", "18:30"];
  const first = nextSlots(3, slots, ROME, new Set(), from);
  assert.deepEqual(first.map((t) => localParts(t, ROME)).map((p) => `${p.d} ${p.h}:${p.min}`), ["11 18:30", "12 9:0", "12 18:30"]);

  const taken = new Set([first[0]]);
  assert.equal(localParts(nextSlots(1, slots, ROME, taken, from)[0], ROME).d, 12);

  // Only Mondays allowed: the next slot is Monday the 16th.
  const monday = nextSlots(1, slots, ROME, new Set(), from, [1])[0];
  assert.deepEqual([localParts(monday, ROME).d, weekdayOf(monday, ROME)], [16, 1]);
});

test("no slots or no active days means nothing can be scheduled automatically", () => {
  assert.deepEqual(nextSlots(2, [], ROME, new Set()), []);
  assert.deepEqual(nextSlots(2, ["09:00"], ROME, new Set(), Date.now(), []), []);
});

test("a suggestion counts as rewritten only after a real change", () => {
  const original = "La costanza batte il talento quando il talento non pubblica mai nulla.";
  assert.equal(madeOwn(original, original), false);
  assert.equal(madeOwn(original, original + "!"), false);
  assert.equal(madeOwn(original, "  " + original.replace("mai", "mai\n")), false, "whitespace alone is not a rewrite");
  assert.equal(madeOwn(original, "Ho visto persone più brave di me smettere dopo tre post. Io sono ancora qui."), true);
  assert.equal(editDistance("casa", "cassa"), 1);
});

test("plain text becomes the document Substack expects, with paragraphs and links", () => {
  const doc = textToBodyJson("Prima riga\n\nSeconda con https://example.com/x dentro\n\n\n");
  assert.equal(doc.content.length, 2);
  assert.deepEqual(doc.content[0], { type: "paragraph", content: [{ type: "text", text: "Prima riga" }] });
  const link = doc.content[1].content[1] as { text: string; marks: { type: string; attrs: { href: string } }[] };
  assert.equal(link.text, "https://example.com/x");
  assert.equal(link.marks[0].attrs.href, "https://example.com/x");
});

test("an empty text produces an empty document rather than an empty paragraph", () => {
  assert.equal(textToBodyJson("  \n\n ").content.length, 0);
});
