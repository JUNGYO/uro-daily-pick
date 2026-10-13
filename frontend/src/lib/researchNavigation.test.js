import { expect, it, vi } from "vitest";
vi.mock("./supabase", () => ({ supabase: {} }));
import { atlasLink, paperFromAtlas, paperAtlasLink, switchRelationship } from "./researchNavigation";
it("round-trips a selected pair and project with bibliographic filters", () => {
  const original = new URLSearchParams({
    project: "42",
    concept: "a".repeat(24),
    with: "b".repeat(24),
    from: "2020",
    journal: "Urology",
    returnTo: "/projects?project=42",
  });
  const citations = switchRelationship(original, "citations");
  expect(citations.get("concept")).toBeNull();
  expect(citations.get("scopeConcept")).toBe(original.get("concept"));
  citations.set("concept", "12345");
  citations.set("citationPage", "2");
  expect(switchRelationship(citations, "citations").toString()).toBe(citations.toString());
  const back = switchRelationship(citations, "concepts");
  expect([...back].sort()).toEqual([...original].sort());
});
it("retains a durable map return through paper notes and citation re-entry", () => {
  const map =
    "/insights?relation=citations&project=42&scopeConcept=" +
    "a".repeat(24) +
    "&concept=12345&citationView=timeline&returnTo=%2Fprojects%3Fproject%3D42";
  const paper = paperFromAtlas("12345", map);
  expect(new URL(paper, "https://local.test").searchParams.get("returnTo")).toBe(map);
  const reentry = paperAtlasLink("12345", map, paper + "&tab=notes");
  expect(reentry).toBe(map);
});
it("keeps own-library search scope and blocks unsafe return destinations", () => {
  const link = atlasLink({
    library: "notes",
    query: "renal cohort",
    returnTo: "/library?tab=notes&q=renal+cohort",
  });
  const params = new URL(link, "https://local.test").searchParams;
  expect(params.get("scope_q")).toBe("renal cohort");
  expect(params.get("library")).toBe("notes");
  expect(
    new URL(atlasLink({ returnTo: "//outside.test" }), "https://local.test").searchParams.get("returnTo"),
  ).toBe("/");
  expect(
    new URL(paperFromAtlas("12345", "https://outside.test"), "https://local.test").searchParams.get(
      "returnTo",
    ),
  ).toBe("/");
});

it("keeps a paper's library origin through an additional map visit", () => {
  const map = paperAtlasLink("12345", "/library?tab=notes&q=cohort", "/papers/12345?tab=notes");
  const paperBack = new URL(map, "https://local.test").searchParams.get("returnTo");
  expect(new URL(paperBack, "https://local.test").searchParams.get("returnTo")).toBe(
    "/library?tab=notes&q=cohort",
  );
});
