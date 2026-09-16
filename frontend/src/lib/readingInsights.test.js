import { describe, expect, it } from "vitest";
import { paperTopics, studyMethod } from "./paperTaxonomy";
import {
  buildReadingEntries,
  activityEntries,
  activityBuckets,
  topicCounts,
  readingStreak,
  heatmapData,
} from "./readingInsights";

const today = "2026-09-16";
const papers = [
  {
    id: 1,
    keywords: [" Prostate Cancer ", "prostate cancer", "AI"],
    mesh_terms: ["Prostatic Neoplasms", "Artificial Intelligence", "Humans"],
  },
  { id: 2, keywords: '["Bladder cancer"]', mesh_terms: ["Urinary Bladder Neoplasms"] },
  { id: 3, keywords: ["machine learning"], study_type: "ai_ml" },
  { id: 4, keywords: [], mesh_terms: [] },
];
function fixture() {
  return buildReadingEntries({
    papers,
    states: [
      {
        paper_id: 1,
        reading_state: "read",
        read_at: "2026-09-14T16:00:00Z",
        saved: true,
        saved_at: "2026-05-01T01:00:00Z",
        note: "My evidence note",
        updated_at: "2026-09-16T01:00:00Z",
      },
      { paper_id: 2, reading_state: "reading", saved: true, saved_at: "2026-09-14T00:00:00Z" },
      { paper_id: 3, reading_state: "read", read_at: null, updated_at: "2026-09-16T01:00:00Z" },
      {
        paper_id: 4,
        reading_state: "unread",
        read_at: "2026-09-16T01:00:00Z",
        saved: false,
        saved_at: "2026-09-16T01:00:00Z",
      },
    ],
    views: [
      { paper_id: 2, clicked_at: "2026-09-15T15:00:00Z", dwell_seconds: 10 },
      { paper_id: 2, clicked_at: "2026-09-16T02:00:00Z" },
      { paper_id: 2, clicked_at: "2026-09-14T02:00:00Z" },
      { paper_id: 1, clicked_at: "2026-09-16T02:00:00Z" },
      { paper_id: 3, clicked_at: "not a timestamp" },
    ],
    feedback: [{ paper_id: 4, action: "like", created_at: "2025-01-01T00:00:00Z" }],
  });
}

describe("personal reading activity semantics", () => {
  it("keeps a ten-second view, explicit read, save and like separate", () => {
    const entries = fixture();
    expect(activityEntries(entries, "read", "30", today).map((entry) => entry.paper.id)).toEqual([1]);
    expect(activityEntries(entries, "saved", "30", today).map((entry) => entry.paper.id)).toEqual([2]);
    expect(activityEntries(entries, "liked", "30", today)).toEqual([]);
    expect(activityEntries(entries, "viewed", "30", today).map((entry) => entry.paper.id)).toEqual([1, 2]);
  });
  it("never substitutes updated_at for unknown action dates or revives cleared states", () => {
    const entries = fixture();
    expect(activityEntries(entries, "read", "all", today).map((entry) => entry.paper.id)).toEqual([1, 3]);
    expect(activityBuckets(entries, "read", "all", today)).toEqual({ "2026-09-15": 1 });
    expect(readingStreak(entries, today)).toBe(1);
  });
  it("deduplicates each paper per KST day and month with exact drilldown", () => {
    const entries = fixture();
    expect(activityBuckets(entries, "viewed", "30", today)).toEqual({ "2026-09-14": 1, "2026-09-16": 2 });
    expect(activityBuckets(entries, "viewed", "30", today, "month")).toEqual({ "2026-09": 2 });
    expect(
      activityEntries(entries, "viewed", "30", today, { day: "2026-09-14" }).map((entry) => entry.paper.id),
    ).toEqual([2]);
    expect(
      activityEntries(entries, "viewed", "30", today, {
        month: "2026-09",
        topic: "urinary bladder neoplasms",
      }).map((entry) => entry.paper.id),
    ).toEqual([2]);
  });
  it("includes the exact period boundary and excludes future/invalid timestamps", () => {
    const entries = buildReadingEntries({
      papers,
      views: [
        { paper_id: 1, clicked_at: "2026-08-17T15:00:00Z" },
        { paper_id: 2, clicked_at: "2026-08-17T14:59:59Z" },
        { paper_id: 3, clicked_at: "2026-09-16T15:00:00Z" },
      ],
    });
    expect(activityEntries(entries, "viewed", "30", today).map((entry) => entry.paper.id)).toEqual([1]);
  });
  it("aligns calendar weekdays in KST and leaves future dates inactive", () => {
    const data = heatmapData({ "2026-09-16": 2 }, 1, today);
    expect(data.cells.slice(0, 3).map((cell) => cell.date)).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
    ]);
    expect(data.cells[2].count).toBe(2);
    expect(data.cells.slice(3)).toEqual([null, null, null, null]);
  });
});

describe("paper metadata taxonomy", () => {
  it("merges only explicit aliases once per paper and preserves both provenance fields", () => {
    const topics = paperTopics(papers[0]);
    expect(topics.map((topic) => topic.id)).toEqual(["prostatic neoplasms", "artificial intelligence"]);
    expect(topics[0].sources).toEqual(["MeSH", "Keywords"]);
    const counts = topicCounts(buildReadingEntries({ papers: [papers[0], papers[0]] }));
    expect(counts.every((topic) => topic.count === 1)).toBe(true);
    expect(paperTopics({ keywords: ["AI", "machine learning", "renal cancer", "RCC"] })).toHaveLength(4);
  });
  it("keeps missing metadata visible as unclassified and does not use a title as evidence", () => {
    expect(
      paperTopics({ title: "Bladder cancer", keywords: "malformed", mesh_terms: ["Humans"] })[0].id,
    ).toBe("unclassified");
    expect(studyMethod({ study_type: "ai_ml" }).id).toBe("unclassified");
    expect(studyMethod({ study_type: "surgical" }).id).toBe("unclassified");
  });
  it("recognizes leading design descriptions without treating every mention as a design", () => {
    expect(
      studyMethod({
        structured_data: { study_design: "Retrospective cohort study at a single high-volume center" },
      }).id,
    ).toBe("retrospective");
    expect(studyMethod({ study_design: "A multicenter randomized controlled trial of surgery" }).id).toBe(
      "rct",
    );
    expect(studyMethod({ study_design: "Systematic review and meta-analysis of RCTs" }).id).toBe(
      "meta_analysis",
    );
    expect(studyMethod({ study_design: "Non-randomized controlled trial" }).id).toBe("unclassified");
    expect(studyMethod({ study_design: "Editorial discussing a retrospective study" }).id).toBe(
      "unclassified",
    );
  });
});
