import { describe, expect, it } from "vitest";
import {
  conceptAtlasLabels,
  conceptAtlasLayout,
  conceptMapCoverage,
  conceptMapSnapshot,
} from "./conceptAtlas";

const group = {
  id: "group:condition",
  label: "Disease",
  kind: "condition",
  node_type: "group",
  concept_count: 250,
  document_count: 1000,
};
const concept = {
  id: "concept:rare",
  label: "Rare biological process",
  kind: "biological_process",
  node_type: "concept",
  document_count: 1,
};

describe("complete concept map representation", () => {
  it("counts group members plus pinned concepts without hiding a rare isolated concept", () => {
    const data = {
      nodes: [group, concept],
      map: { represented_concepts: 251, scope_concepts: 17000, complete: true },
    };
    expect(conceptMapCoverage(data)).toEqual({
      represented: 251,
      expected: 251,
      scope: 17000,
      groups: 1,
      concepts: 1,
      complete: true,
    });
    const layout = conceptAtlasLayout(data.nodes, [], 288, 470);
    expect(layout.map((p) => p.id)).toContain(concept.id);
    expect(layout.find((p) => p.id === concept.id).r).toBeGreaterThan(0);
  });
  it("does not advertise completeness when member totals disagree", () => {
    expect(
      conceptMapCoverage({ nodes: [group], map: { represented_concepts: 251, complete: true } }).complete,
    ).toBe(false);
  });
  it("retains every node and fits even dense views to narrow containers", () => {
    const nodes = Array.from({ length: 80 }, (_, i) => ({
      ...concept,
      id: `concept:${i}`,
      label: `Concept ${i}`,
      document_count: i + 1,
    }));
    const points = conceptAtlasLayout(nodes, [], 288, 470);
    expect(points).toHaveLength(80);
    for (const point of points) {
      expect(point.x - point.r).toBeGreaterThan(0);
      expect(point.x + point.r).toBeLessThan(288);
      expect(point.y - point.r).toBeGreaterThan(0);
      expect(point.y + point.r).toBeLessThan(470);
    }
    expect(conceptAtlasLabels(points, 288, 470).size).toBeLessThan(80);
    expect(points).toHaveLength(80); // Label suppression never changes graph membership.
  });
  it("keeps layout stable across response order and preserves count-area ratios", () => {
    const nodes = [group, concept, { ...concept, id: "concept:twice", document_count: 2 }];
    const edges = [{ source: group.id, target: concept.id, weight: 1 }];
    const points = conceptAtlasLayout(nodes, edges, 800, 560);
    expect(points).toEqual(conceptAtlasLayout([...nodes].reverse(), [...edges].reverse(), 800, 560));
    const single = points.find((p) => p.id === concept.id),
      twice = points.find((p) => p.id === "concept:twice");
    expect(twice.r ** 2 / single.r ** 2).toBeCloseTo(2);
  });
  it("centers one concept and handles an empty scope", () => {
    expect(conceptAtlasLayout([], [], 288, 470)).toEqual([]);
    expect(conceptAtlasLayout([concept], [], 288, 470)[0]).toMatchObject({ x: 144, y: 235 });
  });
  it("re-evaluates labels at zoom level while preserving their screen text size", () => {
    const points = Array.from({ length: 8 }, (_, i) => ({
      ...concept,
      id: `close:${i}`,
      label: `Close concept ${i}`,
      x: 220 + (i % 4) * 30,
      y: 230 + Math.floor(i / 4) * 30,
      r: 3,
      document_count: 10,
    }));
    const base = conceptAtlasLabels(points, 560, 500);
    const zoomed = conceptAtlasLabels(points, 560, 500, [], { zoom: 3, pan: { x: 0, y: 0 } });
    expect(zoomed.size).toBeGreaterThan(base.size);
    for (const label of zoomed.values()) expect(label.fontSize * 3).toBe(12);
  });
  it("exports group semantics, full view membership and coverage", () => {
    const data = {
      nodes: [group, concept],
      edges: [],
      map: { level: "overview", complete: true },
      coverage: { concepts: 251 },
      filters: { from: 2020 },
      matched_documents: 1000,
    };
    const snapshot = conceptMapSnapshot(data);
    expect(snapshot.nodes).toEqual(data.nodes);
    expect(snapshot.map).toEqual(data.map);
    expect(snapshot.method.groups).toContain("not inferred research clusters");
    expect(snapshot.method.counts).toContain("must not be summed");
  });
});
