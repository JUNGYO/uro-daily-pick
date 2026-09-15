import { expect, it } from "vitest";
import { automaticPaper, recentPaper } from "./catalogPolicy";

it("includes 2000-01-01 and rejects older, missing and invalid dates", () => {
  for (const pub_date of ["1999-12-31", null, "", "invalid", "2000-02-30"])
    expect(automaticPaper({ pub_date })).toBe(false);
  expect(automaticPaper({ pub_date: "2000-01-01" })).toBe(true);
});

it("uses the same inclusive five-year and leap-day boundaries as the worker", () => {
  expect(recentPaper({ pub_date: "2021-09-15" }, "2026-09-15")).toBe(true);
  expect(recentPaper({ pub_date: "2021-09-14" }, "2026-09-15")).toBe(false);
  expect(recentPaper({ pub_date: "2019-02-28" }, "2024-02-29")).toBe(true);
});
