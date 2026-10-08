// Quantities refer to distinct indexed papers, never independent studies or
// clinical evidence strength. MeSH categories describe entities, not their role
// as a treatment/exposure/outcome in an individual paper.
export const CATEGORY_LABELS = {
  condition: "Disease",
  anatomy: "Anatomy",
  substance: "Substance",
  organism: "Organism",
  technique: "Technique",
  biological_process: "Biological process",
  psychology: "Psychology",
  discipline: "Discipline",
  social: "Society",
  technology: "Technology",
  humanities: "Humanities",
  information: "Information",
  population: "Population",
  healthcare: "Health care",
  publication: "Publication type",
  geography: "Geography",
  multiple: "Multiple MeSH categories",
  unclassified: "Unresolved term",
  paper: "Paper",
};
export const CATEGORY_COLORS = {
  condition: "#225ea8",
  anatomy: "#b34c2d",
  substance: "#8053a0",
  organism: "#37826b",
  technique: "#16778c",
  biological_process: "#8c6923",
  psychology: "#9c516c",
  multiple: "#526b7a",
  unclassified: "#87919e",
  paper: "#225ea8",
};
export const categoryColor = (kind) => CATEGORY_COLORS[kind] || "#526b7a";
export const overlap = (edge, nodes) => {
  const a = nodes.find((n) => n.id === edge.source),
    b = nodes.find((n) => n.id === edge.target);
  const union = Number(a?.document_count) + Number(b?.document_count) - Number(edge.weight);
  return union > 0 ? Number(edge.weight) / union : 0;
};
export const edgeWidth = (weight) => 1 + Math.log2(Math.max(1, Number(weight)));
export const nodeRadius = (count, maximum) =>
  34 * Math.sqrt(Math.max(1, Number(count)) / Math.max(1, maximum));

function seed(id) {
  let n = 2166136261;
  for (const c of id) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return (n >>> 0) / 4294967296;
}

// Deterministic weighted force layout, with no later grid snapping. Stable IDs
// and sorted input make refreshes/input ordering reproducible. Coordinates are
// a navigation aid; they are not numerical distances or clinical similarity.
export function networkLayout(nodes, edges) {
  const maximum = Math.max(1, ...nodes.map((n) => Number(n.document_count)));
  const points = [...nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => {
      const theta = seed(n.id) * Math.PI * 2;
      return {
        ...n,
        r: nodeRadius(n.document_count, maximum) * Math.min(1, Math.sqrt(30 / nodes.length)),
        x: 500 + Math.cos(theta) * 320,
        y: 340 + Math.sin(theta) * 220,
        vx: 0,
        vy: 0,
      };
    });
  const index = new Map(points.map((p) => [p.id, p]));
  const links = edges
    .filter((e) => index.has(e.source) && index.has(e.target))
    .map((e) => ({ ...e, strength: overlap(e, nodes) }))
    .sort((a, b) => (a.source + a.target).localeCompare(b.source + b.target));
  for (let step = 0; step < 280; step++) {
    const cooling = 1 - step / 340;
    for (const p of points) {
      p.vx = (p.vx + (500 - p.x) * 0.003) * 0.6;
      p.vy = (p.vy + (340 - p.y) * 0.003) * 0.6;
    }
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i],
          b = points[j];
        let dx = b.x - a.x,
          dy = b.y - a.y;
        if (Math.abs(dx) + Math.abs(dy) < 0.01) {
          dx = 0.1;
          dy = 0.1;
        }
        const d = Math.max(1, Math.hypot(dx, dy)),
          minimum = a.r + b.r + 38;
        const force = Math.min(6, 1000 / (d * d) + Math.max(0, minimum - d) * 0.12);
        a.vx -= (dx / d) * force;
        b.vx += (dx / d) * force;
        a.vy -= (dy / d) * force;
        b.vy += (dy / d) * force;
      }
    for (const e of links) {
      const a = index.get(e.source),
        b = index.get(e.target),
        dx = b.x - a.x,
        dy = b.y - a.y,
        d = Math.max(1, Math.hypot(dx, dy));
      const target = 100 + 180 * (1 - e.strength),
        f = (d - target) * 0.012 * Math.sqrt(Math.max(0.01, e.strength));
      a.vx += (dx / d) * f;
      b.vx -= (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vy -= (dy / d) * f;
    }
    for (const p of points) {
      p.x = Math.max(80, Math.min(920, p.x + p.vx * cooling));
      p.y = Math.max(65, Math.min(610, p.y + p.vy * cooling));
    }
  }
  return points;
}

export function networkSnapshot(data) {
  return {
    format: "uro-research-network-v1",
    exported_at: new Date().toISOString(),
    source_updated_at: data.updated_at,
    relationship: data.relationship,
    filters: data.filters,
    coverage: data.coverage,
    indexed_papers: data.indexed_documents,
    matching_papers: data.matched_documents,
    method: {
      node: "Resolved MeSH concept or explicitly unresolved extracted term",
      edge:
        data.relationship === "citations"
          ? "Identified reference, citing paper to referenced paper"
          : "Distinct indexed papers containing both extracted concepts",
      overlap: "shared / (source papers + target papers - shared)",
      layout: "deterministic weighted force; coordinates are not a measurement",
      selection:
        "Most frequent concepts or newest papers, with selected items retained; bounded node and link counts",
      interpretation:
        "Exploratory indexed corpus; not independent study counts, clinical effects or consensus",
    },
    nodes: data.nodes,
    edges: data.edges,
  };
}
