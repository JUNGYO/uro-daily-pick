// Synthetic indexed-original graph for browser regression tests only.
// Three disconnected research modules share papers within each module; kinds
// deliberately cross modules so ontology classes cannot explain the grouping.
const conceptId = (i) => (12000 + i).toString(16).padStart(24, "0");
export const communityRareId = conceptId(119);
export const communityRareLabel = "Rare longitudinal stone outcome";
export const communityIsolatedLabel = "Isolated source-bound observation";
const themes = [
  "Prostate surveillance",
  "Bladder preservation",
  "Stone recurrence",
];
const concepts = Array.from({ length: 120 }, (_, i) => {
  const module = Math.floor(i / 40);
  const paperIds = [module * 2 + 1, ...(i % 40 === 39 ? [] : [module * 2 + 2])];
  return {
    id: conceptId(i),
    label:
      i === 119
        ? communityRareLabel
        : `${themes[module]} concept ${String((i % 40) + 1).padStart(2, "0")}`,
    kind: ["substance", "psychology", "technology", "unclassified"][i % 4],
    node_type: "concept",
    concept_count: 1,
    document_count: paperIds.length,
    paper_ids: paperIds,
    resolution: "unmapped",
    source_labels: [],
  };
});
concepts.push({
  id: conceptId(120),
  label: communityIsolatedLabel,
  kind: "unclassified",
  node_type: "concept",
  concept_count: 1,
  document_count: 1,
  paper_ids: [7],
  resolution: "unmapped",
  source_labels: [],
});

function fixturePapers(papers) {
  return Array.from({ length: 8 }, (_, i) => ({
    ...papers[i % papers.length],
    id: i + 1,
    pmid: String(98000001 + i),
    title:
      i < 6
        ? `${themes[Math.floor(i / 2)]} indexed original ${(i % 2) + 1}`
        : i === 6
          ? "Isolated indexed original"
          : "Indexed original awaiting concept extraction",
    journal: "Synthetic original research",
    pub_date: `${i % 2 ? 2025 : 2024}-03-01`,
    study_type: "RCT",
    structured: true,
  }));
}

export function researchCommunitiesFixture(name, filters = {}, papers) {
  const allPapers = fixturePapers(papers);
  const matchingPapers = allPapers.filter(
    (paper) =>
      Number(paper.pub_date.slice(0, 4)) >= (filters.from || 2000) &&
      Number(paper.pub_date.slice(0, 4)) <= (filters.to || 2100) &&
      (!filters.journal || filters.journal === paper.journal) &&
      (!filters.design || filters.design === paper.study_type),
  );
  const matchingIds = new Set(matchingPapers.map((paper) => paper.id));
  const nodes = concepts
    .map((node) => {
      const paper_ids = node.paper_ids.filter((id) => matchingIds.has(id));
      return { ...node, paper_ids, document_count: paper_ids.length };
    })
    .filter((node) => node.document_count > 0);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const group = filters.group_entities || filters.scope_entities;
  const groupPapers = group
    ? new Set(group.flatMap((id) => byId.get(id)?.paper_ids || []))
    : matchingIds;
  const topic = byId.get(filters.scope_concept);
  const topicPeer = byId.get(filters.scope_peer);
  const selection =
    name === "knowledge_concept_map" ? byId.get(filters.focus) : null;
  const peer = name === "knowledge_concept_map" ? byId.get(filters.peer) : null;
  const selectedPapers = matchingPapers.filter(
    (paper) =>
      groupPapers.has(paper.id) &&
      [topic, topicPeer, selection, peer].every(
        (node) => !node || node.paper_ids.includes(paper.id),
      ),
  );
  const years = [
    ...new Set(selectedPapers.map((p) => Number(p.pub_date.slice(0, 4)))),
  ]
    .sort()
    .map((year) => ({
      year,
      papers: selectedPapers.filter(
        (p) => Number(p.pub_date.slice(0, 4)) === year,
      ).length,
      structured: selectedPapers.filter(
        (p) => Number(p.pub_date.slice(0, 4)) === year,
      ).length,
    }));
  const common = {
    filters,
    focus: filters.focus,
    peer: filters.peer,
    indexed_documents: allPapers.length,
    matched_documents: selectedPapers.length,
    selected_documents: selectedPapers.length,
    selection_documents: selectedPapers.length,
    structured_documents: selectedPapers.length,
    selection,
    selection_peer: peer,
    papers: selectedPapers.slice(
      (filters.page || 0) * 20,
      (filters.page || 0) * 20 + 21,
    ),
    years,
    journals: [
      { label: "Synthetic original research", papers: allPapers.length },
    ],
    designs: [{ label: "RCT", papers: allPapers.length }],
    notes: [],
    updated_at: "2026-11-02T00:00:00Z",
    context: { topic_label: topic?.label, topic_peer_label: topicPeer?.label },
  };
  if (name === "knowledge_network") {
    const reference = {
      id: "98999999",
      pmid: "98999999",
      label: "Identified fixture reference",
      kind: "reference",
      year: 2020,
      in_catalog: false,
      indexed: false,
      matching_source: false,
      incoming_citations: selectedPapers.length,
      identified_references: 0,
    };
    const sources = selectedPapers.map((paper) => ({
      ...paper,
      id: paper.pmid,
      label: paper.title,
      kind: "paper",
      year: Number(paper.pub_date.slice(0, 4)),
      in_catalog: true,
      indexed: true,
      matching_source: true,
      incoming_citations: 0,
      identified_references: 1,
    }));
    const graph = [...sources, reference];
    return {
      ...common,
      relationship: "citations",
      nodes: graph,
      edges: sources.map((paper) => ({
        source: paper.id,
        target: reference.id,
        weight: 1,
      })),
      citation_selection: graph.filter((node) =>
        [filters.focus, filters.peer].includes(node.id),
      ),
      citation_papers: graph,
      citation_paper_count: graph.length,
      unlinked_papers: [],
      coverage: {
        citation_nodes: graph.length,
        citation_links: sources.length,
        metadata_papers: sources.length,
        papers_with_reference_ids: sources.length,
        reference_identifiers: sources.length,
        displayed_sources: sources.length,
        displayed_references: 1,
        unlinked_papers: 0,
      },
    };
  }
  const edges = [];
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const weight = nodes[i].paper_ids.filter((id) =>
        nodes[j].paper_ids.includes(id),
      ).length;
      if (weight)
        edges.push({ source: nodes[i].id, target: nodes[j].id, weight });
    }
  return {
    ...common,
    relationship: "concepts",
    nodes,
    edges,
    map: {
      level: "overview",
      grouping: "full_graph",
      complete: true,
      represented_concepts: nodes.length,
      scope_concepts: nodes.length,
      branch_concepts: nodes.length,
      breadcrumbs: [],
    },
    coverage: {
      concepts: nodes.length,
      represented_concepts: nodes.length,
      all_graph: true,
      all_links: true,
      node_limit: null,
      edge_limit: null,
      documents_without_concepts: matchingPapers.filter(
        (paper) => !nodes.some((node) => node.paper_ids.includes(paper.id)),
      ).length,
    },
  };
}
