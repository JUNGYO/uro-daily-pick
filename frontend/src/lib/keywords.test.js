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
    paper: { title: "Veterans Affairs", keywords: ["urology"], study_type: "retrospective" },
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

it("rejects historical AI reasons from repair/remains, including absent terms and mixed casing", () => {
  for (const matched_terms of [[], ["AI"], ["ai"]]) {
    const rec = normalizeRec({
      paper: { abstract: "DNA mismatch repair (MMR) genes. Their relevance remains incompletely defined." },
      reasons: {
        matched_terms,
        reasons: [
          { type: "keyword", label: "AI" },
          { type: "keyword", label: "ai" },
          { type: "alert", label: "Alert: AI" },
        ],
      },
    });
    expect(rec.reasons.matched_terms).toEqual([]);
    expect(rec.reasons.reasons).toEqual([]);
  }
});

it("preserves journal and author subscriptions while validating keyword alerts against paper text", () => {
  const rec = normalizeRec({
    paper: { title: "DNA mismatch repair", journal: "European Urology", authors: ["Ai Lee"] },
    reasons: {
      reasons: [
        { type: "alert", alert_type: "journal", label: "Alert: Urol" },
        { type: "alert", alert_type: "author", label: "Alert: Ai Lee" },
        { type: "alert", alert_type: "keyword", label: "Alert: AI" },
      ],
    },
  });
  expect(rec.reasons.reasons.map((r) => r.label)).toEqual(["Alert: Urol", "Alert: Ai Lee"]);
});
