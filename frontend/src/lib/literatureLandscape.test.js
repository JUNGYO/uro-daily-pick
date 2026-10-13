import { describe, expect, it } from "vitest";
import { landscapePeriods, periodCount, sortedFlows } from "./literatureLandscape";
describe("whole-catalog landscape", () => {
  it("conserves counts through empty intervals and unknown years", () => {
    const years = [
      { year: 1998, papers: 120 },
      { year: 2026, papers: 245 },
      { year: null, papers: 7 },
    ];
    const periods = landscapePeriods(years);
    expect(periods[0].label).toBe("1995–1999");
    expect(periods.map((p) => periodCount(years, p)).reduce((a, b) => a + b, 0)).toBe(372);
    expect(periodCount(years, periods[2])).toBe(0);
    expect(periodCount(years, periods.at(-1))).toBe(7);
  });
  it("handles empty and undated-only corpora without fabricated dates", () => {
    expect(landscapePeriods([])).toEqual([]);
    expect(landscapePeriods([{ year: null, papers: 3 }], 1)).toEqual([
      { key: "unknown", from: null, to: null, label: "Unknown" },
    ]);
  });
  it("retains every directed year pair including future references and unknowns", () => {
    const flows = [
      { source_year: null, target_year: null, links: 1 },
      { source_year: 2024, target_year: 2025, links: 2 },
      { source_year: 2024, target_year: 1998, links: 3 },
    ];
    expect(sortedFlows(flows).map((f) => f.links)).toEqual([2, 3, 1]);
    expect(flows[0].source_year).toBeNull();
  });
});
