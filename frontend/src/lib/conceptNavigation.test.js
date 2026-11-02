import { describe, expect, it } from "vitest";
import { browseConceptMap, resetConceptMap, selectConceptMap } from "./conceptNavigation";

describe("complete concept map navigation", () => {
  it("opens a group without changing the research scope or selected anchors", () => {
    const original = new URLSearchParams("project=42&from=2024&concept=a&with=b&page=3&limit=100");
    const next = browseConceptMap(original, { category: "condition", prefix: "0/1" });
    expect(next.get("project")).toBe("42");
    expect(next.get("concept")).toBe("a");
    expect(next.get("with")).toBe("b");
    expect(next.get("prefix")).toBe("0/1");
    expect(next.has("limit")).toBe(false);
    expect(next.has("page")).toBe(false);
    expect(original.get("page")).toBe("3");
  });
  it("retains the first selected concept while inspecting a second", () => {
    const next = selectConceptMap(new URLSearchParams("concept=a&category=condition&prefix=1"), "b");
    expect(next.toString()).toBe("concept=a&with=b");
    expect(selectConceptMap(next, "a").toString()).toBe("concept=a");
  });
  it("returns to all concepts within the user's project, filters and library search", () => {
    const next = resetConceptMap(
      new URLSearchParams(
        "library=notes&scope_q=renal&from=2021&concept=a&with=b&category=condition&prefix=1",
      ),
    );
    expect(next.toString()).toBe("library=notes&scope_q=renal&from=2021");
  });
});
