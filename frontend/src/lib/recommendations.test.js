import { it, expect, vi } from "vitest";
const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { from } }));
import { getDailyPicks, rankPapers } from "./recommendations";

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
