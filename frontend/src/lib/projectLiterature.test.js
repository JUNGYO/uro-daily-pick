import { describe, expect, it } from "vitest";
import {
  buildProjectLiterature,
  literatureDistribution,
  projectCell,
  projectGraphWindow,
  projectNeighbors,
  referenceStatus,
} from "./projectLiterature";

const reference = (id, paper = {}) => ({
  id,
  paper_id: id + 100,
  bibliography: { title: `Paper ${id}`, pmid: String(40000000 + id) },
  paper,
  user_values: {},
  auto_values: {},
});

describe("bounded project literature model", () => {
  it("uses live paper readiness, never user values or extraction success as original proof", () => {
    expect(
      referenceStatus({
        ...reference(1),
        extraction_status: "complete",
        source_content_hash: "hash",
        user_values: { fulltext_available: true },
      }).id,
    ).toBe("bibliography");
    expect(referenceStatus(reference(2, { fulltext_available: true })).id).toBe("original");
    expect(referenceStatus(reference(3, { summary_ready: true })).id).toBe("summary");
  });

  it("deduplicates reference and topic links without inventing citations", () => {
    const row = reference(1, { mesh_terms: ["Prostatic Neoplasms"] });
    const model = buildProjectLiterature(
      [row, row],
      [
        {
          id: 7,
          title: "My argument",
          reference_ids: [1, 1, 999],
          cell_links: [{ reference_id: 1, column_id: "outcome" }],
        },
      ],
    );
    expect(model.papers).toHaveLength(1);
    expect(model.nodes.find((node) => node.kind === "argument").omittedReferences).toBe(1);
    expect(model.edges.filter((edge) => edge.kind === "linked")).toHaveLength(1);
    expect(model.edges.filter((edge) => edge.kind === "classified")).toHaveLength(1);
    expect(model.edges.every((edge) => ["linked", "classified"].includes(edge.kind))).toBe(true);
    expect(projectNeighbors(model, "argument:7")[0].edge.cellLinks).toEqual([
      { reference_id: 1, column_id: "outcome" },
    ]);
  });

  it("counts each paper once per topic and leaves missing methodology unclassified", () => {
    const model = buildProjectLiterature([
      reference(1, {
        mesh_terms: ["Prostatic Neoplasms", "Prostatic Neoplasms"],
        keywords: ["prostate cancer"],
        study_type: "rct",
      }),
      reference(2, { mesh_terms: ["Prostatic Neoplasms"], study_type: "imaging" }),
      reference(3, { study_type: "ai", title: "Randomized prostate cancer trial" }),
    ]);
    const groups = literatureDistribution(model);
    expect(groups.find((group) => group.id !== "unclassified").papers).toHaveLength(2);
    expect(groups.find((group) => group.id === "unclassified").papers).toHaveLength(1);
    const methods = literatureDistribution(model, "methods");
    expect(methods.find((group) => group.id === "rct").papers).toHaveLength(1);
    expect(methods.find((group) => group.id === "unclassified").papers).toHaveLength(2);
    expect(model.nodes.some((node) => node.id === "topic:unclassified")).toBe(false);
  });

  it("expands only known neighbors with a hard fifty-node canvas bound", () => {
    const model = buildProjectLiterature(
      Array.from({ length: 60 }, (_, index) => reference(index + 1)),
      [{ id: 9, title: "Connected", reference_ids: Array.from({ length: 60 }, (_, index) => index + 1) }],
    );
    const initial = projectGraphWindow(model, "argument:9");
    expect(initial.nodes).toHaveLength(30);
    expect(initial.hiddenNeighbors).toBe(31);
    const expanded = projectGraphWindow(model, "argument:9", true);
    expect(expanded.nodes).toHaveLength(50);
    expect(expanded.nodes[0].id).toBe("argument:9");
    expect(expanded.hiddenNeighbors).toBe(11);
    const visible = new Set(expanded.nodes.map((node) => node.id));
    expect(expanded.edges.every((edge) => visible.has(edge.from) && visible.has(edge.to))).toBe(true);
  });

  it("shows a selected off-window node and ignores unknown identifiers", () => {
    const model = buildProjectLiterature(Array.from({ length: 50 }, (_, index) => reference(index + 1)));
    expect(projectGraphWindow(model, "paper:50").nodes[0].id).toBe("paper:50");
    expect(projectNeighbors(model, "missing")).toEqual([]);
    expect(projectGraphWindow(model, "missing").nodes).toHaveLength(30);
  });

  it("does not attach automatic evidence to user-edited cells", () => {
    const row = {
      ...reference(1),
      auto_values: { outcome: "automatic" },
      user_values: { outcome: "my interpretation" },
      evidence: { outcome: ["p-0000001", "private-path"] },
      source_content_hash: "hash",
      extraction_status: "complete",
    };
    expect(projectCell(row, "outcome")).toMatchObject({
      value: "my interpretation",
      origin: "사용자 입력",
      evidence: [],
    });
    row.user_values = {};
    expect(projectCell(row, "outcome")).toMatchObject({
      value: "automatic",
      current: true,
      evidence: ["p-0000001"],
    });
    row.extraction_status = "stale";
    expect(projectCell(row, "outcome").current).toBe(false);
  });
});
