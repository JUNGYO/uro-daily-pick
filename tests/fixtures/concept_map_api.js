// Synthetic, complete hierarchy for browser tests. No external API or real papers.
const categoryLabels = {
  condition: "Disease",
  technique: "Technique",
  substance: "Substance",
};
const allConcepts = Array.from({ length: 260 }, (_, i) => ({
  id: (i + 1000).toString(16).padStart(24, "0"),
  label:
    i === 129
      ? "Rare pathway outside the first hundred"
      : `${i < 130 ? "Prostate pathway" : i < 220 ? "Imaging technique" : "Investigational substance"} ${String(i + 1).padStart(3, "0")}`,
  kind: i < 130 ? "condition" : i < 220 ? "technique" : "substance",
  document_count: 1,
  concept_count: 1,
  node_type: "concept",
  paperIndex: i % 3,
  source_labels: [],
  resolution: "unmapped",
}));

export function conceptMapFixture(base, filters, scenario, papers) {
  if (scenario !== "atlas-whole-corpus")
    return {
      ...base,
      nodes: base.nodes.map((n) => ({
        ...n,
        node_type: "concept",
        concept_count: 1,
      })),
      map: {
        level: "overview",
        complete: true,
        grouping: "concepts",
        represented_concepts: base.nodes.length,
        scope_concepts: base.nodes.length,
        breadcrumbs: [],
      },
      coverage: {
        ...base.coverage,
        represented_concepts: base.nodes.length,
        node_limit: null,
        edge_limit: null,
        documents_without_concepts: 0,
      },
    };
  const focus = allConcepts.find((n) => n.id === filters.focus);
  const peer = allConcepts.find((n) => n.id === filters.peer);
  const focused = allConcepts.filter(
    (n) =>
      (!focus || n.paperIndex === focus.paperIndex) &&
      (!peer || n.paperIndex === peer.paperIndex),
  );
  const category = filters.category || "";
  const prefix = filters.prefix || "";
  const categoryNodes = focused
    .filter((n) => !category || n.kind === category)
    .sort((a, b) => a.label.localeCompare(b.label));
  const branch = prefix
    ? categoryNodes.slice(Number(prefix) * 80, Number(prefix) * 80 + 80)
    : categoryNodes;
  const represented = [
    ...new Map(
      [...branch, focus, peer].filter(Boolean).map((n) => [n.id, n]),
    ).values(),
  ];
  const assignments = new Map();
  for (const n of represented) {
    const pinned = n.id === focus?.id || n.id === peer?.id;
    const group = !pinned && branch.length > 80;
    const range = Math.floor(
      categoryNodes.findIndex((item) => item.id === n.id) / 80,
    );
    const id = !group
      ? n.id
      : !category
        ? `category:${n.kind}`
        : `range:${category}:${range}`;
    if (!assignments.has(id))
      assignments.set(id, { id, members: [], group, range, kind: n.kind });
    assignments.get(id).members.push(n);
  }
  const nodes = [...assignments.values()].map(
    ({ id, members, group, range, kind }) => {
      const first = members[0],
        last = members[members.length - 1];
      return {
        ...first,
        id,
        label: !group
          ? first.label
          : !category
            ? categoryLabels[kind]
            : `${first.label} – ${last.label}`,
        node_type: group ? "group" : "concept",
        concept_count: members.length,
        document_count: new Set(members.map((n) => n.paperIndex)).size,
        drill: group
          ? { category: kind, prefix: category ? String(range) : "" }
          : null,
        paperIndexes: [...new Set(members.map((n) => n.paperIndex))],
      };
    },
  );
  const edges = [];
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i],
        b = nodes[j],
        weight = a.paperIndexes.filter((p) =>
          b.paperIndexes.includes(p),
        ).length;
      if (weight >= (filters.min_shared || 1))
        edges.push({ source: a.id, target: b.id, weight });
    }
  const selectedPaperIndexes = new Set(branch.map((n) => n.paperIndex));
  const selectedPapers = papers
    .slice(0, 3)
    .filter((_, i) => selectedPaperIndexes.has(i));
  const crumbs = category
    ? [{ label: categoryLabels[category], category, prefix: "" }]
    : [];
  if (prefix && branch.length)
    crumbs.push({
      label: `${branch[0].label} – ${branch[branch.length - 1].label}`,
      category,
      prefix,
    });
  return {
    ...base,
    nodes,
    edges,
    filters,
    selection: focus || null,
    selection_peer: peer || null,
    notes: [],
    papers: selectedPapers.map((p) => ({ ...p, structured: true })),
    indexed_documents: 3,
    matched_documents: 3,
    selected_documents: selectedPapers.length,
    selection_documents: new Set(focused.map((n) => n.paperIndex)).size,
    structured_documents: selectedPapers.length,
    years: [
      {
        year: 2024,
        papers: selectedPapers.length,
        structured: selectedPapers.length,
      },
    ],
    map: {
      level: !category ? "overview" : prefix ? "prefix" : "category",
      category,
      prefix,
      complete: true,
      grouping:
        branch.length <= 80
          ? "concepts"
          : category
            ? "alphabetical_range"
            : "mesh_category",
      represented_concepts: represented.length,
      scope_concepts: focused.length,
      branch_concepts: branch.length,
      breadcrumbs: crumbs,
    },
    coverage: {
      concepts: focused.length,
      represented_concepts: represented.length,
      resolved: 0,
      node_limit: null,
      edge_limit: null,
      links_at_threshold: edges.length,
      all_links: true,
      documents_without_concepts: 0,
    },
  };
}
