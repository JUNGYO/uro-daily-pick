import { describe, it, expect } from "vitest";
import {
  citationModel,
  citationNeighborhood,
  citationTimeline,
  citationRadius,
  citationLabel,
} from "./citationNetwork";
import { networkSnapshot } from "./researchNetwork";
const nodes = [
  { id: "a", label: "Recent", year: 2024, authors: ["Smith Jane"], incoming_citations: 0 },
  { id: "b", label: "Prior", year: 2010, authors: ["Jones Adam"], incoming_citations: 8 },
  { id: "c", label: "No date", year: null, pmid: "12345" },
];
const edges = [
  { source: "a", target: "b" },
  { source: "a", target: "c" },
];
describe("citation timeline", () => {
  it("keeps directed references distinct from incoming citations", () => {
    const m = citationModel(nodes, [...edges, edges[0], { source: "missing", target: "a" }]);
    expect(m.links).toHaveLength(2);
    expect(m.papers[0].id).toBe("b");
    expect(m.papers[0].incomingShown).toBe(1);
    expect(
      citationNeighborhood(m.papers, m.links, "a", "references")
        .map((n) => n.id)
        .sort(),
    ).toEqual(["b", "c"]);
    expect(citationNeighborhood(m.papers, m.links, "b", "cited-by").map((n) => n.id)).toEqual(["a"]);
    expect(citationNeighborhood(m.papers, m.links, "a", "cited-by")).toEqual([]);
  });
  it("uses linear years, keeps undated papers separate and is deterministic", () => {
    const m = citationModel(nodes, edges),
      graph = citationTimeline(m.papers, m.links, 900);
    expect(graph.points.find((n) => n.id === "a").x).toBeGreaterThan(
      graph.points.find((n) => n.id === "b").x,
    );
    expect(graph.points.find((n) => n.id === "c").x).toBeGreaterThan(
      graph.points.find((n) => n.id === "a").x,
    );
    const reversed = citationModel([...nodes].reverse(), [...edges].reverse());
    expect(citationTimeline(reversed.papers, reversed.links, 900)).toEqual(graph);
    expect(graph.points).toHaveLength(3);
    expect(graph.ticks[0].year).toBe(2010);
    expect(graph.unknown).toBe(true);
  });
  it("does not move same-year papers to invented dates and avoids overlapping labels", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      id: String(i),
      year: 2024,
      authors: [`Author ${i} Test`],
      incoming_citations: i % 21,
    }));
    const links = many.slice(1).map((n) => ({ source: n.id, target: "0" }));
    const m = citationModel(many, links);
    for (const width of [300, 700, 1000]) {
      const g = citationTimeline(m.papers, m.links, width);
      expect(new Set(g.points.map((n) => n.x)).size).toBe(1);
      expect(new Set(g.points.map((n) => n.y)).size).toBe(60);
      expect(g.points.every((n) => n.x >= 0 && n.x <= width && n.y >= 0 && n.y < g.height)).toBe(true);
    }
  });
  it("reports missing author/date without guessing and defines capped area", () => {
    expect(citationLabel(nodes[0])).toBe("Smith Jane · 2024");
    expect(citationLabel(nodes[2])).toBe("PMID 12345 · n.d.");
    expect(citationRadius(8) ** 2 / citationRadius(0) ** 2).toBeCloseTo(9);
    expect(citationRadius(100)).toBe(citationRadius(20));
    expect(citationTimeline([], [], 300).points).toEqual([]);
  });
  it("exports citation-specific methods without co-occurrence similarity", () => {
    const s = networkSnapshot({ relationship: "citations", nodes, edges });
    expect(s.method.overlap).toBeNull();
    expect(s.method.layout).toContain("publication-year");
    expect(s.method.citation_count_scope).toContain("not global");
  });
});
