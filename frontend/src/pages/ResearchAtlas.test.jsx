import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ResearchAtlas from "./ResearchAtlas";
import { buildConceptCommunityTree } from "../lib/conceptCommunities";

const { rpc, authUser } = vi.hoisted(() => ({ rpc: vi.fn(), authUser: { id: "reader" } }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: authUser }) }));
vi.mock("../lib/workspace", () => ({ rpc, safeReturn: (value) => value || "/" }));
vi.mock("../components/ReaderUI", () => ({
  Resource: ({ resource, children }) =>
    resource.loading ? (
      <p>Loading evidence</p>
    ) : resource.error ? (
      <p role="alert">{resource.error}</p>
    ) : (
      children
    ),
}));
vi.mock("../components/KnowledgeEvidence", () => ({
  ENGLISH_RESOURCE: {},
  KnowledgeNarrative: () => null,
  ScientificPaper: ({ paper }) => <article>{paper.title}</article>,
}));
vi.mock("../components/ConceptAtlas", () => ({
  default: ({ data, onDrill, onSelectConcept }) => (
    <div aria-label="Test concept graph">
      {data.nodes.map((node) => (
        <button
          key={node.id}
          onClick={() => (node.node_type === "group" ? onDrill(node) : onSelectConcept(node.id))}
        >
          {node.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../components/CitationNetwork", () => ({
  default: ({ data }) => (
    <div aria-label="Citation evidence">{data.selected_documents} scoped citation papers</div>
  ),
}));

const ids = [1, 2, 3, 4].map((id) => id.toString(16).padStart(24, "0"));
const base = {
  nodes: ids.map((id, i) => ({
    id,
    label: ["Prostate cancer", "Prostatectomy", "Kidney stones", "Lithotripsy"][i],
    kind: i % 2 ? "intervention" : "condition",
    node_type: "concept",
    document_count: 2,
    paper_ids: i < 2 ? [1001, 1002] : [1003, 1004],
  })),
  edges: [
    { source: ids[0], target: ids[1], weight: 2 },
    { source: ids[2], target: ids[3], weight: 2 },
  ],
  map: { grouping: "full_graph", complete: true },
  coverage: { all_graph: true, concepts: 4 },
  matched_documents: 4,
  indexed_documents: 4,
  structured_documents: 0,
  selected_documents: 4,
  papers: [{ pmid: 1001, title: "All-scope paper" }],
  years: [{ year: 2025, papers: 4, structured: 0 }],
  journals: [],
  designs: [],
  notes: [],
  context: {},
};
const group = buildConceptCommunityTree(base)
  .view()
  .nodes.find((node) => node.node_type === "group");
const members = buildConceptCommunityTree(base).members(group.drill.cluster);

beforeEach(() => {
  authUser.id = "reader";
  rpc.mockReset();
  rpc.mockImplementation(async (name, { p_filters: filters }) => {
    if (name === "knowledge_network") return { ...base, selected_documents: 2, papers: [] };
    if (filters.group_entities?.length || filters.focus)
      return {
        ...base,
        selected_documents: 2,
        years: [{ year: 2025, papers: 2, structured: 0 }],
        papers: [{ pmid: 1002, title: "Selected-community paper" }],
        selection: base.nodes.find((node) => node.id === filters.focus),
      };
    return base;
  });
});

describe("ResearchAtlas full-text communities", () => {
  it("hides the previous account's selected evidence while the new account's graph loads", async () => {
    const content = (
      <MemoryRouter initialEntries={[`/insights?cluster=${encodeURIComponent(group.drill.cluster)}`]}>
        <ResearchAtlas />
      </MemoryRouter>
    );
    const view = render(content);
    await screen.findByText("Selected-community paper");
    rpc.mockImplementation(() => new Promise(() => {}));
    authUser.id = "another-reader";
    view.rerender(
      <MemoryRouter initialEntries={[`/insights?cluster=${encodeURIComponent(group.drill.cluster)}`]}>
        <ResearchAtlas />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Selected-community paper")).not.toBeInTheDocument();
    expect(screen.getByText("Loading evidence")).toBeInTheDocument();
  });

  it("replaces obsolete taxonomy URL fields when the complete graph is available", async () => {
    function Location() {
      return <output aria-label="Current query">{useLocation().search}</output>;
    }
    render(
      <MemoryRouter initialEntries={["/insights?category=substance&prefix=0"]}>
        <ResearchAtlas />
        <Location />
      </MemoryRouter>,
    );
    await screen.findAllByRole("button", { name: group.label });
    await waitFor(() => expect(screen.getByLabelText("Current query")).toHaveTextContent(/^$/));
    expect(screen.queryByText("Concept category: substance")).not.toBeInTheDocument();
  });

  it("loads the whole graph and scopes papers and years to the clicked group's actual members", async () => {
    render(
      <MemoryRouter initialEntries={["/insights"]}>
        <ResearchAtlas />
      </MemoryRouter>,
    );
    await screen.findAllByRole("button", { name: group.label });
    const initial = rpc.mock.calls[0][1].p_filters;
    expect(initial.graph).toBe(true);
    expect(initial.focus).toBeUndefined();
    fireEvent.click(screen.getAllByRole("button", { name: group.label })[0]);
    await screen.findByText("Selected-community paper");
    expect(screen.queryByText("All-scope paper")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2025: 2 papers; 0 structured" })).toBeInTheDocument();
    expect(
      rpc.mock.calls.some(
        ([name, args]) =>
          name === "knowledge_concept_map" &&
          JSON.stringify(args.p_filters.group_entities) === JSON.stringify(members),
      ),
    ).toBe(true);
  });

  it("keeps the community's member set when opening citations and clears it with filters", async () => {
    render(
      <MemoryRouter initialEntries={[`/insights?cluster=${encodeURIComponent(group.drill.cluster)}`]}>
        <ResearchAtlas />
      </MemoryRouter>,
    );
    await screen.findByText("Selected-community paper");
    fireEvent.click(screen.getByRole("button", { name: "Citations", exact: true }));
    await screen.findByText("2 scoped citation papers");
    const citation = rpc.mock.calls.filter(([name]) => name === "knowledge_network").at(-1)[1].p_filters;
    expect(citation.scope_entities).toEqual(members);
    expect(citation.group_entities).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(screen.queryByText("2 scoped citation papers")).not.toBeInTheDocument());
    expect(screen.getByText("Choose a starting point for citations")).toBeInTheDocument();
  });
});
