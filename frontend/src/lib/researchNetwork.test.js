import { describe, it, expect } from "vitest";
import { networkLayout, nodeRadius, edgeWidth, overlap, networkSnapshot } from "./researchNetwork";
const nodes = [
  { id: "a", label: "A", document_count: 10 },
  { id: "b", label: "B", document_count: 5 },
  { id: "c", label: "C", document_count: 8 },
];
const edges = [
  { source: "a", target: "b", weight: 3 },
  { source: "b", target: "c", weight: 2 },
];
describe("scientific network encodings", () => {
  it("encodes counts in area, preserving the ratio", () => {
    expect(nodeRadius(10, 10) ** 2 / nodeRadius(5, 10) ** 2).toBeCloseTo(2);
    expect(edgeWidth(8)).toBe(4);
  });
  it("computes overlap from distinct-paper union", () => {
    expect(overlap(edges[0], nodes)).toBe(0.25);
  });
  it("is deterministic and insensitive to row order", () => {
    expect(networkLayout(nodes, edges)).toEqual(networkLayout([...nodes].reverse(), [...edges].reverse()));
  });
  it("uses actual relationship weights without snapping to a grid", () => {
    const a = networkLayout(nodes, edges),
      b = networkLayout(nodes, [{ ...edges[0], weight: 5 }, edges[1]]);
    expect(a.map((n) => [n.x, n.y])).not.toEqual(b.map((n) => [n.x, n.y]));
    expect(a.every((n) => Number.isFinite(n.x) && Number.isFinite(n.r))).toBe(true);
  });
  it("retains every selected node, including isolated nodes", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      label: "Node " + i,
      document_count: 1,
    }));
    expect(networkLayout(many, [])).toHaveLength(100);
  });
  it("exports the scope, identifiers and counting rules", () => {
    const d = {
      relationship: "concepts",
      nodes,
      edges,
      filters: { from: 2000, min_shared: 2 },
      coverage: { concepts: 3 },
      matched_documents: 20,
    };
    const value = networkSnapshot(d);
    expect(value.filters).toEqual(d.filters);
    expect(value.edges).toEqual(edges);
    expect(value.method.interpretation).toContain("not independent study");
  });
});
