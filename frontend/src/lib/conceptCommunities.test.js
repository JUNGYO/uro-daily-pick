import { describe, expect, it } from "vitest";
import { buildConceptCommunityTree, partitionModularity } from "./conceptCommunities";

const node = (id, papers = [], label = id) => ({
  id,
  label,
  kind: "unclassified",
  document_count: papers.length,
  paper_ids: papers,
});
function fixture() {
  const nodes = Array.from({ length: 120 }, (_, i) =>
    node(`n${String(i).padStart(3, "0")}`, [Math.floor(i / 4)], `Original concept ${i}`),
  );
  nodes.push(node("isolated", [50], "Rare original concept"));
  const edges = [];
  for (let i = 0; i < 120; i++)
    for (let j = i + 1; j < 120; j++) {
      if (Math.floor(i / 4) === Math.floor(j / 4))
        edges.push({ source: nodes[i].id, target: nodes[j].id, weight: 1 });
    }
  return { nodes, edges, selected_documents: 31 };
}

describe("complete full-text research communities", () => {
  it("retains every original, including rare, unresolved and isolated concepts beyond 100", () => {
    const data = fixture(),
      tree = buildConceptCommunityTree(data),
      root = tree.view();
    expect(root.nodes.reduce((n, item) => n + item.concept_count, 0)).toBe(121);
    expect(root.nodes.some((item) => item.id === "isolated")).toBe(true);
    expect(root.nodes.filter((item) => item.node_type === "group")).toHaveLength(30);
    const all = root.nodes.flatMap((item) => (item.drill ? tree.members(item.drill.cluster) : [item.id]));
    expect(all.sort()).toEqual(data.nodes.map((item) => item.id).sort());
    expect(
      root.nodes.some((item) => /^(Unresolved term|Substance|Psychology|Technology)$/.test(item.label)),
    ).toBe(false);
    const group = root.nodes.find((item) => item.drill);
    expect(tree.view(group.drill.cluster).nodes).toHaveLength(4);
    expect(tree.breadcrumbs(group.drill.cluster)[0].label).toBe(group.label);
  });
  it("uses graph relationships rather than ontology kind and is independent of input order", () => {
    const data = fixture(),
      expected = buildConceptCommunityTree(data).levels;
    const shuffled = {
      nodes: [...data.nodes]
        .reverse()
        .map((item, i) => ({ ...item, kind: i % 2 ? "substance" : "technology" })),
      edges: [...data.edges].reverse(),
    };
    expect(buildConceptCommunityTree(shuffled).levels).toEqual(expected);
  });
  it("increases weighted modularity and never joins disconnected components", () => {
    const data = fixture(),
      tree = buildConceptCommunityTree(data);
    const scores = tree.levels.map((partition) => partitionModularity(data.nodes, data.edges, partition));
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1] - 1e-10);
    for (const group of tree.levels.at(-1)) {
      if (group.includes("isolated")) expect(group).toEqual(["isolated"]);
      else expect(new Set(group.map((id) => Math.floor(Number(id.slice(1)) / 4))).size).toBe(1);
    }
  });
  it("counts each supporting paper once per community and per displayed connection", () => {
    const data = fixture();
    for (const item of data.nodes.slice(0, 8)) {
      item.paper_ids.push(999);
      item.document_count++;
    }
    // Keep the two tightly connected modules separate; a shared paper may
    // contain many terms in both and must not become 4×4 papers on its edge.
    const root = buildConceptCommunityTree(data).view();
    const groups = root.nodes.filter((item) => item.paper_ids.includes(999));
    expect(groups).toHaveLength(2);
    expect(groups.map((item) => item.document_count)).toEqual([2, 2]);
    expect(root.edges).toEqual([
      { source: groups.map((g) => g.id).sort()[0], target: groups.map((g) => g.id).sort()[1], weight: 1 },
    ]);
    expect(buildConceptCommunityTree(data).view("", { minimum: 2 }).nodes).toHaveLength(root.nodes.length);
  });
  it("pins selected actual concepts without losing or double-counting group members", () => {
    const data = fixture(),
      tree = buildConceptCommunityTree(data);
    const view = tree.view("", { selected: "n000", peer: "n001" });
    expect(view.nodes.filter((item) => item.pinned).map((item) => item.id)).toEqual(["n000", "n001"]);
    expect(view.nodes.reduce((n, item) => n + item.concept_count, 0)).toBe(121);
    expect(tree.has("missing")).toBe(false);
    expect(tree.members("missing")).toEqual([]);
  });
  it("preserves a graph with no links as individual concepts", () => {
    const nodes = Array.from({ length: 153 }, (_, i) => node(String(i), [i]));
    const result = buildConceptCommunityTree({ nodes, edges: [] }).view();
    expect(result.nodes).toHaveLength(153);
    expect(result.nodes.every((item) => item.node_type === "concept")).toBe(true);
    expect(result.map.complete).toBe(true);
  });
});
