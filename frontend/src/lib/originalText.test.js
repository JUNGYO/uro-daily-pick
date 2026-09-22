import { expect, test } from "vitest";
import { originalParagraphs, readingLayout, sourceLocations } from "./originalText";

function sourceBlocks(text) {
  const characters = [...text];
  const blocks = [];
  let start = 0;
  for (const line of text.split("\n")) {
    const end = start + [...line].length;
    for (let offset = start; offset < end; offset += 1400) {
      const stop = Math.min(offset + 1400, end);
      blocks.push({
        id: `p-${String(offset).padStart(7, "0")}`,
        start: offset,
        end: stop,
        text: characters.slice(offset, stop).join(""),
      });
    }
    start = end + 1;
  }
  return blocks;
}

const restored = (text, blocks) =>
  originalParagraphs(text, sourceLocations(text, blocks))
    .map((p) => p.runs.map((r) => r.text).join(""))
    .join("\n");

test("source location boundaries cannot become paragraphs or split words", () => {
  const text = "a".repeat(1392) + " entirel" + "y at the clinician's discretion.\n\nSecond paragraph.";
  const blocks = sourceBlocks(text);
  const paragraphs = originalParagraphs(text, sourceLocations(text, blocks));
  expect(blocks[0].text.endsWith("entirel")).toBe(true);
  expect(paragraphs).toHaveLength(3);
  expect(paragraphs[0].runs.map((r) => r.text).join("")).toContain("entirely at");
  expect(restored(text, blocks)).toBe(text);
});

test("invalid, overlapping, duplicated and missing locators never hide source text", () => {
  const text = "Full source text before and after.\nFinal paragraph.";
  const valid = { id: "p-0000005", start: 5, end: 11, text: "source" };
  const blocks = [
    valid,
    valid,
    { ...valid, id: "p-0000000", text: "incorrect" },
    { id: "p-0000009", start: 9, end: 13, text: text.slice(9, 13) },
  ];
  expect(sourceLocations(text, blocks)).toEqual([valid]);
  expect(restored(text, blocks)).toBe(text);
  expect(restored(text, undefined)).toBe(text);
});

test("Python Unicode offsets retain every character and stable locator ID", () => {
  const text = "𝛼🧬" + "x".repeat(1400) + "終わり\nSecond 🩺 line.";
  const blocks = sourceBlocks(text);
  const normalized = sourceLocations(text, blocks);
  expect(normalized).toHaveLength(blocks.length);
  expect(normalized[1].start).toBe(1402);
  expect(normalized[1].id).toBe("p-0001400");
  expect(restored(text, blocks)).toBe(text);
});

test("the locator cap cannot truncate a long original", () => {
  const text = Array.from({ length: 4010 }, (_, i) => `Paragraph ${i}.`).join("\n");
  const blocks = sourceBlocks(text);
  expect(sourceLocations(text, blocks)).toHaveLength(4000);
  expect(restored(text, blocks)).toBe(text);
  expect(restored(text, blocks).endsWith("Paragraph 4009.")).toBe(true);
});

test("stored publisher paragraphs may split an evidence chunk without losing its anchor", () => {
  const text = "Heading\nFirst paragraph. Second paragraph.\nTail.";
  const raw = {
    version: 1,
    content_hash: "source",
    blocks: [
      { kind: "heading", start: 0, end: 7 },
      { kind: "paragraph", start: 8, end: 24 },
      { kind: "paragraph", start: 25, end: 42 },
      { kind: "paragraph", start: 43, end: 48 },
    ],
  };
  raw.blocks[3].end = text.length;
  const layout = readingLayout(text, "source", raw);
  expect(layout).not.toBeNull();
  const paragraphs = originalParagraphs(text, sourceLocations(text, sourceBlocks(text)), layout);
  expect(paragraphs[1].runs.map((r) => r.text).join("")).toBe("First paragraph.");
  expect(paragraphs[2].runs.map((r) => r.text).join("")).toBe("Second paragraph.");
  expect(paragraphs.flatMap((p) => p.runs).filter((r) => r.id === "p-0000008")).toHaveLength(1);
  expect(readingLayout(text, "changed", raw)).toBeNull();
  expect(readingLayout(text, "source", { ...raw, blocks: raw.blocks.slice(0, -1) })).toBeNull();
});
