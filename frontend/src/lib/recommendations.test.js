import { beforeEach, it, expect, vi } from "vitest";
const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { from } }));
import { getDailyPicks, rankPapers } from "./recommendations";
import { hasFulltextSummary } from "./summary";
import { kstDate } from "./data";

const ready = {
  fulltext_available: true,
  summary_basis: "fulltext",
  summary_ko: "Design\nResults\nLimitations",
  summary_source_hash: "a".repeat(64),
  summary_model: "fixture",
  summarized_at: "2026-09-14T00:00:00Z",
};
beforeEach(() => from.mockReset());

it("excludes pre-2000 summaries while retaining eligible papers without abstracts", () => {
  const paper = { ...ready, id: 17, title: "Prostate outcomes", abstract: "", pub_date: "1937-11-01" };
  expect(rankPapers([paper], { keywords: ["prostate"] })).toEqual([]);
  expect(
    rankPapers([{ ...paper, pub_date: "2000-01-01" }], { keywords: ["prostate"] }).map((r) => r.paper.id),
  ).toEqual([17]);
});

it("does not recommend Veterans Affairs for AI keywords or keyword alerts", () => {
  const paper = {
    ...ready,
    id: 1,
    title: "Active Surveillance Use for Favorable-Risk Prostate Cancer in a Veterans Affairs Population.",
    abstract: "Available clinical findings. ".repeat(10),
    pub_date: "2000-01-01",
  };
  expect(rankPapers([paper], { keywords: ["AI"] })).toEqual([]);
  expect(rankPapers([paper], {}, new Set(), [{ alert_type: "keyword", value: "AI" }])).toEqual([]);
  expect(rankPapers([{ ...paper, title: "AI-assisted diagnosis" }], { keywords: ["AI"] })[0].terms).toEqual([
    "ai",
  ]);
});

it("leaves a historical date empty instead of filling it with new papers", async () => {
  const query = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    order() {
      return Promise.resolve({ data: [] });
    },
  };
  from.mockReturnValue(query);
  expect(await getDailyPicks("reader", "2000-01-01")).toEqual([]);
  expect(from).toHaveBeenCalledTimes(1);
});
it("excludes seen papers and matches configured author alerts", () => {
  const papers = [1, 2].map((id) => ({
    ...ready,
    id,
    title: "Prostate study",
    abstract: "Research findings. ".repeat(20),
    authors: ["Lee J"],
    journal: "",
    pub_date: "2000-01-01",
  }));
  const ranked = rankPapers(papers, { preferred_journals: ["Journal of Urology"] }, new Set([1]), [
    { alert_type: "author", value: "Lee J" },
  ]);
  expect(ranked.map((r) => r.paper.id)).toEqual([2]);
  expect(ranked[0].terms).toEqual(["Alert: Lee J"]);
  expect(rankPapers(papers, { preferred_journals: ["Journal of Urology"] })).toEqual([]);
});

it("prioritizes recent five-year papers before higher-scoring older eligible papers", () => {
  const older = { ...ready, id: 1, title: "Prostate study", journal: "Preferred", pub_date: "2000-01-01" };
  const recent = { ...ready, id: 2, title: "Prostate study", pub_date: kstDate() };
  const ranked = rankPapers([older, recent], { keywords: ["prostate"], preferred_journals: ["Preferred"] });
  expect(ranked.map((r) => r.paper.id)).toEqual([2, 1]);
});

function database(tables) {
  from.mockImplementation((table) => {
    let rows = tables[table] || [],
      single = false;
    const q = {
      select: () => q,
      order: () => q,
      limit: () => q,
      eq: (key, value) => {
        rows = rows.filter((row) => row[key] === value);
        return q;
      },
      gte: (key, value) => {
        rows = rows.filter((row) => row[key] >= value);
        return q;
      },
      in: (key, values) => {
        rows = rows.filter((row) => values.includes(row[key]));
        return q;
      },
      range: (start, end) => {
        rows = rows.slice(start, end + 1);
        return q;
      },
      single: () => {
        single = true;
        return q;
      },
      then: (resolve, reject) => Promise.resolve({ data: single ? rows[0] : rows }).then(resolve, reject),
    };
    return q;
  });
}

it("fills today's stale picks with older ready summaries and preserves a retained pick's feedback", async () => {
  const papers = Array.from({ length: 8 }, (_, i) => ({
    ...ready,
    id: i + 1,
    title: "Prostate outcomes",
    abstract: "Clinical findings. ".repeat(20),
    pub_date: "2026-06-01",
    fetched_at: "2026-06-02",
  }));
  const unready = { ...papers[0], id: 99, fulltext_available: false, pub_date: "2099-01-01" };
  const stored = [papers[0], unready].map((paper) => ({
    id: `saved-${paper.id}`,
    paper_id: paper.id,
    paper,
    user_id: "reader",
    rec_date: kstDate(),
  }));
  database({
    recommendations: stored,
    papers: [...papers, unready],
    profiles: [{ id: "reader", keywords: ["prostate"] }],
    feedbacks: [
      { user_id: "reader", paper_id: 1, action: "like" },
      { user_id: "reader", paper_id: 2, action: "dislike" },
    ],
    read_history: [{ user_id: "reader", paper_id: 3 }],
  });
  const picks = await getDailyPicks("reader", kstDate());
  expect(picks).toHaveLength(5);
  expect(picks[0]).toMatchObject({ id: "saved-1", feedback_action: "like" });
  expect(picks.every((rec) => hasFulltextSummary(rec.paper))).toBe(true);
  expect(picks.map((rec) => rec.paper_id)).toEqual([1, 8, 7, 6, 5]);
});

it("does not disguise unavailable or malformed summaries as completed picks", async () => {
  const base = { ...ready, id: 1, title: "Prostate", abstract: "Findings. ".repeat(20) };
  const papers = [
    { ...base, fulltext_available: false },
    { ...base, summary_basis: "abstract" },
    { ...base, summary_ko: "One line" },
    { ...base, summary_source_hash: null },
    { ...base, summary_model: " " },
    { ...base, summarized_at: null },
  ];
  expect(rankPapers(papers, { keywords: ["prostate"] })).toEqual([]);
  database({ papers, profiles: [{ id: "reader", keywords: ["prostate"] }] });
  expect(await getDailyPicks("reader", kstDate())).toEqual([]);
});

it("keeps an unavailable historical pick and its feedback without replacing the paper", async () => {
  database({
    recommendations: [
      { id: 90, user_id: "reader", rec_date: "2000-01-01", paper_id: 1, paper: { id: 1, title: "Original" } },
    ],
    feedbacks: [{ user_id: "reader", paper_id: 1, action: "like" }],
  });
  const picks = await getDailyPicks("reader", "2000-01-01");
  expect(picks).toHaveLength(1);
  expect(picks[0]).toMatchObject({ id: 90, feedback_action: "like", paper: { title: "Original" } });
  expect(from.mock.calls.map(([table]) => table)).toEqual(["recommendations", "feedbacks"]);
});
