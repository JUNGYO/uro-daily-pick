import { expect, test } from "vitest";
import { citationPresentation, numericCitation, compactCitationNumbers } from "./citationPresentation";

function present(text, specs, references = []) {
  const citations = specs.map(([marker, targets, from = 0]) => {
    const start = text.indexOf(marker, from);
    expect(start).toBeGreaterThanOrEqual(0);
    return { start, end: start + marker.length, text: marker, targets };
  });
  const layout = { blocks: [{ start: 0, end: text.length, kind: "paragraph" }], citations, references };
  const before = JSON.stringify(layout);
  const result = citationPresentation(text, layout);
  expect(JSON.stringify(layout)).toBe(before);
  return result.citations;
}

test.each(["1", "[1]", "(1)", "（1）", "［1］", "1 ••", "1*"])(
  "numeric decorations use common numbering: %s",
  (marker) => {
    const [cite] = present(`Evidence ${marker}.`, [[marker, ["R9"]]]);
    expect(cite.label).toBe("1");
  },
);

test("explicit ranges, repeated markers and split brackets retain their members", () => {
  expect(numericCitation("[ 3 ] – [ 5 ], [5], (8); 10")).toEqual({
    numbers: [3, 4, 5, 8, 10],
    endpoints: [3, 5, 8, 10],
  });
  for (const value of ["195 participants", "2024a", "9–3", "1–10000"])
    expect(numericCitation(value)).toBeNull();
  expect(compactCitationNumbers([3, 2, 1, 3, 7, 9, 8, 12])).toBe("1–3, 7–9, 12");
});

test("range interiors resolve to later native targets and retain unavailable members", () => {
  const text = "Evidence [3–5]. Next [4]. Last [7–9].";
  const cites = present(
    text,
    [
      ["[3–5]", ["B3", "B5"]],
      ["[4]", ["B4"]],
      ["[7–9]", ["B7", "B9"]],
    ],
    [{ id: "B4", text: "4. Alpha. Study." }],
  );
  expect(cites.map((c) => c.label)).toEqual(["1–3", "2", "4–6"]);
  expect(cites[0].entries[1]).toMatchObject({ id: "B4", number: 2, text: "Alpha. Study." });
  expect(cites[2].entries[1]).toMatchObject({ id: undefined, number: 5, text: null });
});

test("author/year groups and repeats share one first-appearance index", () => {
  const text =
    "Evidence (Smith et al., 2024; Jones, 2022). Again (Smith et al., 2024). N = 195, 95% CI, 2024.";
  const cites = present(text, [
    ["Smith et al., 2024; Jones, 2022", ["smith", "jones"]],
    ["Smith et al., 2024", ["smith"], 45],
  ]);
  expect(cites.map((c) => c.label)).toEqual(["1, 2", "1"]);
  expect(cites.every((c) => c.wrapped && c.prefix === "")).toBe(true);
  expect(text.slice(cites[0].start, cites[0].end)).toBe("(Smith et al., 2024; Jones, 2022)");
  expect(text.slice(cites[1].end)).toBe(". N = 195, 95% CI, 2024.");
});

test("narrative authors remain subjects and other parenthetical prose is retained", () => {
  const text = "Smith et al. (2024) reported results (see Jones, 2022 for details).";
  const cites = present(text, [
    ["Smith et al. (2024)", ["smith"]],
    ["Jones, 2022", ["jones"]],
  ]);
  expect(cites[0]).toMatchObject({ label: "1", prefix: "Smith et al. ", wrapped: false });
  expect(text.slice(cites[1].end)).toBe(" for details).");
  expect(cites[1].prefix).toBe("Jones ");
});

test("wrappers inside or outside native links disappear only at citation boundaries", () => {
  const text = "One ( 27 ). Two [ (28) ]. Three (dose 5, [29]).";
  const cites = present(text, [
    ["27", ["R27"]],
    ["(28)", ["R28"]],
    ["29", ["R29"]],
  ]);
  expect(cites.map((c) => text.slice(c.start, c.end))).toEqual(["( 27 )", "[ (28) ]", "[29]"]);
  expect(cites.map((c) => c.label)).toEqual(["1", "2", "3"]);
});

test("different targets sharing a numeric label remain different references", () => {
  const text = "First 2024. Second 2024. Again Smith, 2024.";
  const cites = present(text, [
    ["2024", ["A"]],
    ["2024", ["B"], 14],
    ["Smith, 2024", ["A"]],
  ]);
  expect(cites.map((c) => c.label)).toEqual(["1", "2", "1"]);
});

test("publisher spacing before punctuation is absorbed without consuming punctuation", () => {
  const text = "Evidence ( Smith, 2024 ) . Next (dose 5, [2]) stays.";
  const cites = present(text, [["Smith, 2024", ["smith"]], ["2", ["R2"], 30]]);
  expect(text.slice(cites[0].start, cites[0].end)).toBe("( Smith, 2024 ) ");
  expect(text.slice(cites[0].end)).toBe(". Next (dose 5, [2]) stays.");
  expect(text.slice(cites[1].start, cites[1].end)).toBe("[2]");
});
