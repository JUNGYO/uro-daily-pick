// Complete, deterministic weighted-modularity hierarchy of the original-bound
// co-occurrence graph. Ontology kinds never determine community membership.
// Gain formula: https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.community.louvain.louvain_communities.html
export const COMMUNITY_RESOLUTION = 1.5;
const EPSILON = 1e-10;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const palette = ["#225ea8", "#b34c2d", "#37826b", "#8053a0", "#16778c", "#8c6923", "#9c516c"];

function fingerprint(ids) {
  let a = 2166136261,
    b = 5381;
  for (const char of ids.join("|")) {
    a = Math.imul(a ^ char.charCodeAt(0), 16777619);
    b = Math.imul(b, 33) ^ char.charCodeAt(0);
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}-${ids[0]}`;
}

function graphOf(items, edges) {
  const index = new Map(items.map((item, i) => [item.id, i]));
  const adjacency = items.map(() => new Map());
  const degree = items.map(() => 0);
  let mass = 0;
  for (const edge of edges) {
    const a = index.get(edge.source),
      b = index.get(edge.target),
      weight = Number(edge.weight);
    if (a === undefined || b === undefined || !(weight > 0)) continue;
    mass += weight;
    degree[a] += weight;
    degree[b] += weight;
    if (a !== b) {
      adjacency[a].set(b, (adjacency[a].get(b) || 0) + weight);
      adjacency[b].set(a, (adjacency[b].get(a) || 0) + weight);
    }
  }
  return { adjacency, degree, mass };
}

// After each moving phase, split disconnected pieces. This prevents a label
// from claiming that disconnected concepts form one research community.
function connectedPartition(labels, adjacency) {
  const visited = new Set(),
    groups = [];
  for (let start = 0; start < labels.length; start++) {
    if (visited.has(start)) continue;
    const members = [],
      stack = [start];
    visited.add(start);
    while (stack.length) {
      const current = stack.pop();
      members.push(current);
      for (const neighbor of adjacency[current].keys()) {
        if (labels[neighbor] === labels[start] && !visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    groups.push(members.sort((a, b) => a - b));
  }
  return groups;
}

function moveCommunities(items, edges, resolution) {
  const { adjacency, degree, mass } = graphOf(items, edges);
  const labels = items.map((_, i) => i),
    totals = [...degree];
  if (!mass) return items.map((_, i) => [i]);
  for (let pass = 0; pass < 100; pass++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      const current = labels[i],
        k = degree[i];
      const weights = new Map();
      for (const [neighbor, weight] of adjacency[i]) {
        const label = labels[neighbor];
        weights.set(label, (weights.get(label) || 0) + weight);
      }
      totals[current] -= k;
      const remove = -(weights.get(current) || 0) + (resolution * totals[current] * k) / (2 * mass);
      let best = current,
        bestGain = EPSILON;
      for (const label of [...weights.keys()].sort((a, b) => a - b)) {
        if (label === current) continue;
        const gain = remove + weights.get(label) - (resolution * totals[label] * k) / (2 * mass);
        if (gain > bestGain + EPSILON) {
          best = label;
          bestGain = gain;
        }
      }
      labels[i] = best;
      totals[best] += k;
      if (best !== current) moved = true;
    }
    if (!moved) break;
  }
  return connectedPartition(labels, adjacency);
}

export function partitionModularity(nodes, edges, partition, resolution = COMMUNITY_RESOLUTION) {
  const { degree, mass } = graphOf(nodes, edges);
  if (!mass) return 0;
  const groupById = new Map(),
    totals = partition.map(() => 0),
    inside = partition.map(() => 0);
  partition.forEach((members, group) => members.forEach((id) => groupById.set(id, group)));
  nodes.forEach((node, i) => {
    totals[groupById.get(node.id)] += degree[i];
  });
  for (const edge of edges) {
    const group = groupById.get(edge.source);
    if (group !== undefined && group === groupById.get(edge.target)) inside[group] += Number(edge.weight);
  }
  return totals.reduce((q, total, i) => q + inside[i] / mass - resolution * (total / (2 * mass)) ** 2, 0);
}

const genericLabels = new Set([
  "humans",
  "male",
  "female",
  "animals",
  "quality of life",
  "treatment outcome",
  "risk factors",
  "systematic review",
  "meta-analysis",
  "follow-up",
  "age",
]);

export function buildConceptCommunityTree(data, { resolution = COMMUNITY_RESOLUTION } = {}) {
  const original = [...(data.nodes || [])].sort((a, b) => compare(a.id, b.id));
  const byId = new Map(original.map((node) => [node.id, node]));
  const edges = [...(data.edges || [])]
    .filter((edge) => byId.has(edge.source) && byId.has(edge.target) && Number(edge.weight) > 0)
    .sort((a, b) => compare(a.source, b.source) || compare(a.target, b.target));
  let items = original.map((node) => ({ id: node.id, members: [node.id], children: [] }));
  let currentEdges = edges;
  const levels = [items.map((item) => item.members)];
  for (let level = 0; level < 30; level++) {
    const partition = moveCommunities(items, currentEdges, resolution);
    if (partition.length === items.length) break;
    const parentById = new Map();
    const parents = partition
      .map((positions) => {
        const children = positions.map((i) => items[i]);
        const members = children.flatMap((item) => item.members).sort(compare);
        const parent =
          children.length === 1 ? children[0] : { id: `group:${fingerprint(members)}`, members, children };
        children.forEach((child) => parentById.set(child.id, parent.id));
        return parent;
      })
      .sort((a, b) => compare(a.id, b.id));
    const aggregate = new Map();
    for (const edge of currentEdges) {
      const endpoints = [parentById.get(edge.source), parentById.get(edge.target)].sort(compare);
      const key = endpoints.join("/");
      const existing = aggregate.get(key);
      if (existing) existing.weight += Number(edge.weight);
      else aggregate.set(key, { source: endpoints[0], target: endpoints[1], weight: Number(edge.weight) });
    }
    items = parents;
    currentEdges = [...aggregate.values()];
    levels.push(items.map((item) => item.members));
  }
  const roots = items;
  const tree = new Map(),
    parent = new Map(),
    colors = new Map();
  function register(item, color, parentId = "") {
    tree.set(item.id, item);
    parent.set(item.id, parentId);
    colors.set(item.id, color);
    item.children.forEach((child) => register(child, color, item.id));
  }
  roots.forEach((item, i) => register(item, palette[i % palette.length]));
  const labelCache = new Map();
  function labelOf(item) {
    if (item.members.length === 1) return byId.get(item.members[0]).label;
    if (labelCache.has(item.id)) return labelCache.get(item.id);
    const memberSet = new Set(item.members),
      strength = new Map(item.members.map((id) => [id, 0]));
    for (const edge of edges)
      if (memberSet.has(edge.source) && memberSet.has(edge.target)) {
        strength.set(edge.source, strength.get(edge.source) + Number(edge.weight));
        strength.set(edge.target, strength.get(edge.target) + Number(edge.weight));
      }
    const representatives = item.members
      .map((id) => byId.get(id))
      .sort(
        (a, b) =>
          Number(genericLabels.has(a.label.toLowerCase())) -
            Number(genericLabels.has(b.label.toLowerCase())) ||
          Number(b.document_count) - Number(a.document_count) ||
          strength.get(b.id) - strength.get(a.id) ||
          compare(a.id, b.id),
      );
    const labels = [...new Set(representatives.map((node) => node.label))].slice(0, 3);
    const label = labels.join(" · ");
    labelCache.set(item.id, label);
    return label;
  }
  const papersOf = (members) => [...new Set(members.flatMap((id) => byId.get(id).paper_ids || []))];
  return {
    levels,
    resolution,
    has: (path) => !path || tree.get(path)?.members.length > 1,
    members: (path) => (path ? [...(tree.get(path)?.members || [])] : original.map((node) => node.id)),
    breadcrumbs(path) {
      const crumbs = [];
      while (path && tree.has(path)) {
        const item = tree.get(path);
        crumbs.unshift({ label: labelOf(item), cluster: path });
        path = parent.get(path);
      }
      return crumbs;
    },
    view(path = "", { selected, peer, minimum = 1 } = {}) {
      const branch = path ? tree.get(path) : null;
      const allMembers = branch?.members || original.map((node) => node.id);
      let visible = branch ? branch.children : roots;
      // Within a community of modest size, show all original concepts directly.
      // This is a level-of-detail choice, never a data or node-count cutoff.
      if (branch && branch.members.length <= 80) visible = branch.members.map((id) => tree.get(id));
      const pins = new Set([selected, peer].filter((id) => byId.has(id) && allMembers.includes(id)));
      const nodes = [];
      for (const item of visible) {
        const members = item.members.filter((id) => !pins.has(id));
        if (!members.length) continue;
        const paperIds = papersOf(members);
        const node =
          members.length === 1
            ? { ...byId.get(members[0]), node_type: "concept", concept_count: 1, color: colors.get(item.id) }
            : {
                id: item.id,
                label: labelOf(item),
                kind: "community",
                node_type: "group",
                concept_count: members.length,
                document_count: paperIds.length,
                paper_ids: paperIds,
                color: colors.get(item.id),
                drill: { cluster: item.id },
              };
        nodes.push(node);
      }
      for (const id of pins) {
        nodes.push({
          ...byId.get(id),
          node_type: "concept",
          concept_count: 1,
          pinned: true,
          color: colors.get(id),
        });
      }
      // A group relationship counts distinct papers, never sums all term pairs.
      const paperNodes = new Map();
      for (const node of nodes)
        for (const paper of node.paper_ids || []) {
          if (!paperNodes.has(paper)) paperNodes.set(paper, new Set());
          paperNodes.get(paper).add(node.id);
        }
      const pairWeights = new Map();
      for (const ids of paperNodes.values()) {
        const sorted = [...ids].sort(compare);
        for (let i = 0; i < sorted.length; i++)
          for (let j = i + 1; j < sorted.length; j++) {
            const key = `${sorted[i]}/${sorted[j]}`;
            pairWeights.set(key, (pairWeights.get(key) || 0) + 1);
          }
      }
      const viewEdges = [...pairWeights]
        .filter(([, weight]) => weight >= minimum)
        .map(([key, weight]) => {
          const [source, target] = key.split("/");
          return { source, target, weight };
        });
      return {
        ...data,
        nodes,
        edges: viewEdges,
        coverage: {
          ...data.coverage,
          concepts: original.length,
          represented_concepts: allMembers.length,
          node_limit: null,
        },
        map: {
          level: path ? "community" : "overview",
          cluster: path,
          grouping: "cooccurrence_community",
          complete: true,
          represented_concepts: allMembers.length,
          scope_concepts: original.length,
          branch_concepts: allMembers.length,
          graph_papers: branch
            ? papersOf(allMembers).length
            : Number(data.matched_documents ?? papersOf(allMembers).length),
          graph_filters: data.filters || {},
          algorithm: "deterministic-connected-modularity-v1",
          resolution,
          breadcrumbs: this.breadcrumbs(path),
        },
      };
    },
  };
}
