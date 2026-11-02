import { networkLayout, nodeRadius } from "./researchNetwork";

export const isConceptGroup = (node) => node?.node_type === "group";

// A map is a partition, not a frequency-ranked sample. A group contributes all
// its members; a pinned concept contributes exactly one and is not in a group.
export function conceptMapCoverage(data) {
  const nodes = data.nodes || [];
  const represented = nodes.reduce(
    (sum, node) => sum + (isConceptGroup(node) ? Number(node.concept_count || 0) : 1),
    0,
  );
  const expected = Number(
    data.map?.represented_concepts ?? data.coverage?.represented_concepts ?? represented,
  );
  return {
    represented,
    expected,
    scope: Number(data.map?.scope_concepts ?? data.coverage?.concepts ?? expected),
    groups: nodes.filter(isConceptGroup).length,
    concepts: nodes.filter((node) => !isConceptGroup(node)).length,
    complete: data.map?.complete === true && expected === represented,
  };
}

// The server supplies all groups or all leaves for this view. Never slice here:
// even an isolated/rare concept must retain a visible and keyboard target.
export function conceptAtlasLayout(nodes, edges, width = 800, height = 560) {
  if (!nodes.length) return [];
  const points = networkLayout(nodes, edges);
  const maximum = Math.max(1, ...nodes.map((node) => Number(node.document_count) || 0));
  const density = Math.min(1, Math.sqrt(28 / nodes.length));
  const maxRadius = Math.min(34, width / 10) * density;
  const insetX = Math.min(80, width * 0.16);
  const insetY = 70;
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  return points.map((p) => ({
    ...p,
    x: maxX === minX ? width / 2 : insetX + ((p.x - minX) / (maxX - minX)) * (width - 2 * insetX),
    y: maxY === minY ? height / 2 : insetY + ((p.y - minY) / (maxY - minY)) * (height - 2 * insetY),
    r: (nodeRadius(p.document_count, maximum) / 34) * maxRadius,
  }));
}

const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// Only labels are collision-filtered. Full names remain in each node's
// accessible label, focus/hover readout, and the complete visible-node list.
export function conceptAtlasLabels(points, width, height, priorityIds = [], view = {}) {
  const zoom = view.zoom || 1,
    pan = view.pan || { x: 0, y: 0 };
  const projected = points.map((point) => ({
    ...point,
    x: width / 2 + pan.x + (point.x - width / 2) * zoom,
    y: height / 2 + pan.y + (point.y - height / 2) * zoom,
    r: point.r * zoom,
  }));
  const priority = new Set(priorityIds.filter(Boolean));
  const occupied = [];
  const circles = projected.map((p) => ({
    id: p.id,
    x: p.x - p.r - 4,
    y: p.y - p.r - 4,
    w: 2 * p.r + 8,
    h: 2 * p.r + 8,
  }));
  const result = new Map();
  const sorted = projected.sort(
    (a, b) =>
      Number(priority.has(b.id)) - Number(priority.has(a.id)) ||
      Number(b.document_count) - Number(a.document_count) ||
      a.id.localeCompare(b.id),
  );
  for (const point of sorted) {
    const maximumCharacters = width < 450 ? 22 : 29;
    const fullLabel = point.label || "Unnamed concept";
    const label =
      fullLabel.length > maximumCharacters ? fullLabel.slice(0, maximumCharacters - 1) + "…" : fullLabel;
    const w = Math.min(width - 16, label.length * 6.4 + 6);
    const h = isConceptGroup(point) ? 33 : 18;
    const positions = [
      { x: point.x - w / 2, y: point.y + point.r + 7, w, h },
      { x: point.x - w / 2, y: point.y - point.r - h - 7, w, h },
      { x: point.x + point.r + 8, y: point.y - h / 2, w, h },
      { x: point.x - point.r - w - 8, y: point.y - h / 2, w, h },
    ];
    const box = positions.find(
      (box) =>
        box.x >= 7 &&
        box.x + w <= width - 7 &&
        box.y >= 6 &&
        box.y + h <= height - 6 &&
        !occupied.some((other) => intersects(box, other)) &&
        !circles.some((other) => other.id !== point.id && intersects(box, other)),
    );
    if (box) {
      result.set(point.id, {
        x: (box.x + w / 2 - width / 2 - pan.x) / zoom + width / 2,
        y: (box.y + 13 - height / 2 - pan.y) / zoom + height / 2,
        label,
        fontSize: 12 / zoom,
        detailSize: 10 / zoom,
        lineHeight: 15 / zoom,
      });
      occupied.push(box);
    }
  }
  return result;
}

export function conceptMapSnapshot(data) {
  return {
    format: "uro-concept-atlas-v1",
    exported_at: new Date().toISOString(),
    source_updated_at: data.updated_at,
    filters: data.filters,
    map: data.map,
    coverage: data.coverage,
    indexed_papers: data.indexed_documents,
    matching_papers: data.matched_documents,
    map_level_papers: data.selected_documents ?? data.matched_documents,
    nodes: data.nodes,
    edges: data.edges,
    method: {
      representation: "Complete concept partition of the current indexed-paper scope; no top-N sampling",
      groups:
        data.map?.grouping === "cooccurrence_community"
          ? "Complete full-text co-occurrence communities, deterministic connected modularity; labels are actual representative concepts"
          : "MeSH categories, then alphabetical label ranges; navigation groups, not inferred research clusters",
      node_area: "Distinct matching papers containing this concept or at least one group member",
      edge: "Distinct matching papers containing a member of both endpoints; not citations or causation",
      counts: "Papers may occur in multiple groups; group paper counts must not be summed",
      layout: "Deterministic weighted force; distance is not a scientific measurement",
    },
  };
}
