import { describe, it, expect } from "vitest";
import {
  citationModel,
  citationNeighborhood,
  citationTimeline,
  citationRadius,
  citationLabel,
  citationConnections,
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
  it("fits every endpoint of a dense same-year graph without using years as map coordinates", () => {
    const papers = Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      year: 2024,
      incoming_citations: i === 0 ? 20 : 0,
    }));
    const links = papers.slice(1).map((p) => ({ source: p.id, target: "0" }));
    const m = citationModel(papers, links);
    for (const width of [480, 900]) {
      const graph = citationConnections(m.papers, m.links, width);
      expect(graph.points).toHaveLength(100);
      for (const p of graph.points) {
        expect(p.x - p.r).toBeGreaterThan(0);
        expect(p.x + p.r).toBeLessThan(width);
        expect(p.y - p.r - 16).toBeGreaterThan(0);
        expect(p.y + p.r).toBeLessThan(graph.height);
      }
      const hub = graph.points.find((p) => p.id === "0"),
        leaf = graph.points.find((p) => p.id === "1");
      expect(hub.r ** 2 / leaf.r ** 2).toBeCloseTo(21);
      expect(new Set(graph.points.map((p) => p.x)).size).toBeGreaterThan(1);
      expect(citationConnections([...m.papers].reverse(), [...m.links].reverse(), width)).toEqual(graph);
    }
  });
  it("uses actual links to bring related papers together and handles empty/single-node maps", () => {
    const papers = Array.from({ length: 12 }, (_, i) => ({ id: String(i), incoming_citations: 0 }));
    const links = papers
      .filter((_, i) => i % 4)
      .map((p) => ({ source: p.id, target: String(Math.floor(Number(p.id) / 4) * 4) }));
    const graph = citationConnections(papers, links);
    const index = new Map(graph.points.map((p) => [p.id, p]));
    const distance = (a, b) => Math.hypot(index.get(a).x - index.get(b).x, index.get(a).y - index.get(b).y);
    const linked = links.reduce((sum, e) => sum + distance(e.source, e.target), 0) / links.length;
    const unrelated = papers.flatMap((a) =>
      papers.filter((b) => Math.floor(+a.id / 4) !== Math.floor(+b.id / 4)).map((b) => distance(a.id, b.id)),
    );
    expect(linked).toBeLessThan(unrelated.reduce((a, b) => a + b, 0) / unrelated.length);
    expect(citationConnections([], []).points).toEqual([]);
    expect(citationConnections([papers[0]], []).points[0].x).toBe(450);
  });
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
