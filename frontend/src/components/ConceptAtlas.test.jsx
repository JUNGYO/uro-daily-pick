import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ConceptAtlas from "./ConceptAtlas";

const group = {
  id: "group:condition",
  label: "Disease",
  kind: "condition",
  node_type: "group",
  concept_count: 250,
  document_count: 1000,
  drill: { category: "condition", prefix: "" },
};
const concept = {
  id: "c1",
  label: "Rare concept",
  kind: "condition",
  node_type: "concept",
  document_count: 1,
};
const data = {
  nodes: [group, concept],
  edges: [{ source: group.id, target: concept.id, weight: 1 }],
  map: {
    level: "overview",
    grouping: "mesh_category",
    represented_concepts: 251,
    scope_concepts: 251,
    complete: true,
  },
  matched_documents: 1000,
  coverage: { concepts: 251 },
};

describe("ConceptAtlas exploration", () => {
  it("keeps representative concept names on communities instead of ontology labels", () => {
    const community = {
      ...group,
      label: "Prostate cancer / Active surveillance",
      kind: "community",
      drill: { cluster: "group:prostate" },
    };
    render(
      <ConceptAtlas
        data={{
          ...data,
          nodes: [community, concept],
          map: { ...data.map, grouping: "cooccurrence_community" },
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: /^Prostate cancer \/ Active surveillance, 250 concepts/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Color follows a co-occurrence community")).toBeInTheDocument();
    expect(screen.queryByText("Disease")).not.toBeInTheDocument();
  });
  it("shows complete representation without a top-N selector and drills groups as groups", () => {
    const drill = vi.fn(),
      select = vi.fn();
    render(<ConceptAtlas data={data} onDrill={drill} onSelectConcept={select} />);
    expect(screen.getByText("251 concepts represented")).toBeInTheDocument();
    expect(screen.queryByText("Node limit")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Disease, 250 concepts/ }));
    expect(drill).toHaveBeenCalledWith(group);
    expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: /Rare concept, 1 papers/ }), { key: "Enter" });
    expect(select).toHaveBeenCalledWith("c1");
  });
  it("keeps the shared-paper filter and translates root category labels", () => {
    const change = vi.fn();
    render(
      <ConceptAtlas
        data={{ ...data, nodes: [{ ...group, label: "condition" }, concept] }}
        minimum={1}
        setMinimum={change}
      />,
    );
    expect(screen.getByRole("button", { name: /Disease, 250 concepts/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Minimum shared papers" }), {
      target: { value: "3" },
    });
    expect(change).toHaveBeenCalledWith(3);
    expect(screen.getByRole("button", { name: /Rare concept, 1 papers/ })).toBeInTheDocument();
  });
  it("inspects grouped relationships without putting a synthetic group ID into concept selection", () => {
    const selectEdge = vi.fn(),
      drill = vi.fn();
    render(<ConceptAtlas data={data} onDrill={drill} onSelectEdge={selectEdge} />);
    fireEvent.click(screen.getByRole("button", { name: /Disease and Rare concept: 1 shared papers/ }));
    expect(selectEdge).not.toHaveBeenCalled();
    expect(screen.getByText("1 papers contain concepts from both endpoints.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Disease" }));
    expect(drill).toHaveBeenCalledWith(group);
  });
  it("selects actual concept pairs as supporting-paper queries", () => {
    const other = { ...concept, id: "c2", label: "Second concept", document_count: 3 };
    const selectEdge = vi.fn();
    render(
      <ConceptAtlas
        data={{
          ...data,
          nodes: [concept, other],
          edges: [{ source: "c1", target: "c2", weight: 1 }],
          map: { ...data.map, represented_concepts: 2, scope_concepts: 2 },
        }}
        onSelectEdge={selectEdge}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /Rare concept and Second concept/ }), { key: " " });
    expect(selectEdge).toHaveBeenCalledWith("c1", "c2");
  });
  it("provides every group and isolated concept in an accessible list", () => {
    render(<ConceptAtlas data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "Show accessible concept list" }));
    const list = screen.getByRole("list", { name: "All concepts and groups in this view" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Rare concept")).toBeVisible();
    expect(within(list).getByText("250 concepts · Open group")).toBeVisible();
  });
  it("shows current branch coverage distinctly from overall focused scope", () => {
    render(
      <ConceptAtlas
        data={{
          ...data,
          selected_documents: 16,
          map: { ...data.map, level: "prefix", grouping: "alphabetical_range", scope_concepts: 10000 },
        }}
        breadcrumbs={[{ label: "Whole map", onClick: vi.fn() }, { label: "Disease" }]}
      />,
    );
    expect(screen.getByText("251 concepts represented")).toBeInTheDocument();
    expect(screen.getByText(/16 indexed papers in this map level/)).toBeInTheDocument();
    expect(screen.getByText("10,000 concepts across the selected scope")).toBeInTheDocument();
    expect(
      screen.getByText("Open a label range to reach every concept in this category."),
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Concept map path" })).toBeInTheDocument();
  });
  it("does not move the view on same-scope refresh, and refits after drilling", () => {
    const { rerender } = render(<ConceptAtlas data={data} />);
    const graph = () => screen.getByRole("group", { name: "Concept map from full texts" });
    expect(graph().style.touchAction).toBe("pan-y");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(graph().style.touchAction).toBe("none");
    const transform = () =>
      screen
        .getByRole("group", { name: "Concept map from full texts" })
        .querySelector("g")
        .getAttribute("transform");
    expect(transform()).toContain("scale(1.5)");
    rerender(<ConceptAtlas data={{ ...data, nodes: [...data.nodes] }} />);
    expect(transform()).toContain("scale(1.5)");
    rerender(
      <ConceptAtlas data={{ ...data, map: { ...data.map, level: "category", category: "condition" } }} />,
    );
    expect(transform()).toContain("scale(1)");
    expect(graph().style.touchAction).toBe("pan-y");
  });
  it("explains a community's narrower connection scope and returns to the whole map", () => {
    const reset = vi.fn();
    render(
      <ConceptAtlas
        data={{
          ...data,
          nodes: [
            { ...group, kind: "community", concept_count: 349, drill: { cluster: "large" } },
            {
              ...group,
              id: "group:small",
              label: "Apalutamide",
              kind: "community",
              concept_count: 8,
              drill: { cluster: "small" },
            },
          ],
          edges: [],
          map: {
            ...data.map,
            level: "community",
            grouping: "cooccurrence_community",
            represented_concepts: 357,
            scope_concepts: 5340,
          },
        }}
        breadcrumbs={[{ label: "All concepts", onClick: reset }, { label: "Prostate cancer" }]}
        onReset={reset}
      />,
    );
    expect(screen.getByText("357 concepts represented")).toBeInTheDocument();
    expect(screen.getByText("Within selected community · 2 explorable groups")).toBeInTheDocument();
    expect(screen.getByText("5,340 concepts in the whole map")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Showing connections within this community. Whole map restores the connections between communities.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Whole map" }));
    expect(reset).toHaveBeenCalledOnce();
  });
  it("distinguishes a stable community map's papers from selected concept evidence", () => {
    render(
      <ConceptAtlas
        selected="c1"
        data={{
          ...data,
          selected_documents: 16,
          map: { ...data.map, grouping: "cooccurrence_community", graph_papers: 1000 },
        }}
      />,
    );
    expect(screen.getByText(/1,000 indexed papers in this map level/)).toBeInTheDocument();
    expect(screen.getByText("16 papers in selected evidence")).toBeInTheDocument();
    expect(screen.queryByText(/^16 indexed papers in this map level/)).not.toBeInTheDocument();
  });
});
