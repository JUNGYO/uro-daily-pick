import { it, expect } from "vitest";
import { keywordMatches, keywordPattern } from "./keywords";
import { normalizeRec } from "./data";

it("matches whole literal keywords without highlighting Affairs as AI", () => {
  for (const [text, term, expected] of [
    ["Veterans Affairs", "AI", false],
    ["failure available trial", "AI", false],
    ["(AI), AI-assisted AI/ML", "AI", true],
    ["HTML", "ML", false],
    ["AI_model", "AI", false],
    ["éAI", "AI", false],
    ["AI한글", "AI", false],
    ["prostate\u00a0 cancer", "prostate cancer", true],
    ["C++ study", "C++", true],
    ["C.. study", "C++", false],
    ["text", " ", false],
  ])
    expect(keywordMatches(text, term), text).toBe(expected);
  expect([..."Affairs AI (AI) AI-assisted".matchAll(keywordPattern(["AI"]))]).toHaveLength(3);
});

it("removes stale keyword explanations while preserving metadata and study-type reasons", () => {
  const rec = normalizeRec({
    paper: { title: "Veterans Affairs", keywords: ["urology"] },
    reasons: {
      matched_terms: ["AI", "urology"],
      reasons: [
        { type: "keyword", label: "AI" },
        { type: "keyword", label: "urology" },
        { type: "keyword", label: "Retrospective" },
      ],
    },
  });
  expect(rec.reasons.matched_terms).toEqual(["urology"]);
  expect(rec.reasons.reasons.map((r) => r.label)).toEqual(["urology", "Retrospective"]);
});
