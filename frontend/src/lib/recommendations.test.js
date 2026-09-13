import { it, expect, vi } from "vitest";
const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { from } }));
import { getDailyPicks, rankPapers } from "./recommendations";

it("does not recommend Veterans Affairs for AI keywords or keyword alerts", () => {
  const paper = {
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
