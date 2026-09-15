import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./supabase", () => ({ supabase: { rpc: vi.fn() } }));
import {
  cachePaper,
  cachedPapers,
  removeCached,
  exportReferences,
  csv,
  safeReturn,
  searchArgs,
} from "./workspace";
beforeEach(() => localStorage.clear());
const p = {
  id: 1,
  pmid: "10001",
  title: "A trial: benefits & limits",
  journal: "Urology",
  pub_date: "2026-01-01",
  authors: ["Lee J", "Kim S"],
  doi: "10.1000/trial",
  summary_ko: "첫 줄\n둘째 줄\n셋째 줄",
  content_text: "PRIVATE ORIGINAL",
  figures: [{ caption: "PRIVATE CAPTION" }],
};
it("offline library excludes originals, isolates users and supports deletion", () => {
  cachePaper("one", p);
  expect(cachedPapers("one")).toHaveLength(1);
  expect(cachedPapers("two")).toEqual([]);
  expect(localStorage.getItem("uro-offline:one")).not.toMatch(/PRIVATE|figures|content_text/);
  removeCached("one", p.pmid);
  expect(cachedPapers("one")).toEqual([]);
});
it("limits device library to 100 entries and does not duplicate an article", () => {
  for (let i = 0; i < 101; i++) cachePaper("one", { ...p, pmid: String(i) });
  expect(cachedPapers("one")).toHaveLength(100);
  cachePaper("one", { ...p, pmid: "100" });
  expect(cachedPapers("one")).toHaveLength(100);
});
it("exports author names, identifiers and incomplete citations without invented fields", () => {
  const ris = exportReferences([p], "ris");
  expect(ris).toContain("AU  - Lee J\r\nAU  - Kim S");
  expect(ris).toContain("DO  - 10.1000/trial");
  expect(ris).not.toContain("VL  -");
  const bib = exportReferences([p], "bib");
  expect(bib).toContain("@article{PMID10001");
  expect(bib).toContain("author = {Lee J and Kim S}");
  expect(csv([["=SUM(1)", 'a"b', "\t=1"]])).toBe('\uFEFF"\'=SUM(1)","a""b","\'\t=1"');
});
it("preserves deep links and rejects external or malformed return destinations", () => {
  expect(safeReturn("/papers/10001?tab=study")).toBe("/papers/10001?tab=study");
  for (const x of ["//example.test", "https://example.test", "/\\example.test", "/login?next=x"])
    expect(safeReturn(x)).toBe("/");
  expect(searchArgs(new URLSearchParams("q=전립선암")).p_query).toBe("prostate cancer");
});
