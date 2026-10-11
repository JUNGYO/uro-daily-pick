// Citation counts are bounded by the filtered indexed citing corpus. They are
// never global citation counts, similarity scores or evidence-quality measures.
export function citationModel(nodes = [], edges = []) {
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set();
  const links = edges.filter((e) => {
    const key = `${e.source}:${e.target}`;
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const papers = nodes
    .map((n) => ({
      ...n,
      incomingShown: links.filter((e) => e.target === n.id).length,
      outgoingShown: links.filter((e) => e.source === n.id).length,
    }))
    .sort(
      (a, b) =>
        (b.incoming_citations ?? b.incomingShown) - (a.incoming_citations ?? a.incomingShown) ||
        (Number(b.year) || 0) - (Number(a.year) || 0) ||
        a.id.localeCompare(b.id),
    )
    .map((n, i) => ({ ...n, number: i + 1 }));
  return { papers, links };
}

export function citationLabel(paper) {
  const first = Array.isArray(paper.authors) ? paper.authors[0] : null;
  // Preserve author order as supplied; do not infer a surname from a given name.
  const author = typeof first === "string" ? first.split(",")[0].trim() : "";
  return `${author || (paper.pmid ? `PMID ${paper.pmid}` : "DOI reference")} · ${paper.year || "n.d."}`;
}

export function citationRadius(count) {
  // Area is proportional to 1 + scoped incoming count, capped at 20 citations.
  return 5 * Math.sqrt(1 + Math.min(20, Math.max(0, Number(count) || 0)));
}

export function citationNeighborhood(papers, links, selected, direction = "all") {
  if (!selected) return papers;
  const ids = new Set(
    links.flatMap((e) => [
      ...(e.source === selected && direction !== "cited-by" ? [e.target] : []),
      ...(e.target === selected && direction !== "references" ? [e.source] : []),
    ]),
  );
  return papers.filter((p) => ids.has(p.id));
}

// Horizontal position is publication YEAR on a linear axis, never a fabricated
// date. Vertical lanes group weakly connected papers solely for navigation.
export function citationTimeline(papers, links, width = 900) {
  const compact = width < 580,
    left = 36,
    right = width - 24;
  const known = papers.filter((p) => Number.isInteger(Number(p.year)) && Number(p.year) > 0);
  const years = known.map((p) => Number(p.year));
  const min = Math.min(...years),
    max = Math.max(...years);
  const unknown = known.length !== papers.length;
  const yearRight = unknown && known.length ? right - (compact ? 64 : 130) : right;
  const xFor = (year) =>
    !Number(year)
      ? right - (compact ? 12 : 42)
      : min === max
        ? (left + yearRight) / 2
        : left + ((Number(year) - min) / (max - min)) * (yearRight - left);
  const neighbors = new Map(papers.map((p) => [p.id, []]));
  for (const e of links)
    if (neighbors.has(e.source) && neighbors.has(e.target)) {
      neighbors.get(e.source).push(e.target);
      neighbors.get(e.target).push(e.source);
    }
  const byId = new Map(papers.map((p) => [p.id, p])),
    visited = new Set(),
    groups = [];
  for (const p of papers) {
    if (visited.has(p.id)) continue;
    const group = [],
      queue = [p.id];
    visited.add(p.id);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      group.push(byId.get(id));
      for (const next of neighbors.get(id))
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
    }
    groups.push(group);
  }
  let top = 48;
  const points = [],
    lanes = [];
  for (const group of groups) {
    const occupied = [];
    for (const p of group.sort((a, b) => a.number - b.number)) {
      const r = citationRadius(p.incoming_citations ?? p.incomingShown),
        x = xFor(p.year);
      const label = citationLabel(p),
        labelWidth = Math.min(155, label.length * 6.5);
      const labelX = x + r + 7 + labelWidth < width - 8 ? x + r + 7 : Math.max(8, x - r - 7 - labelWidth);
      let row = 0;
      const box = {
        left: Math.max(0, compact ? x - Math.max(19, r) : Math.min(labelX, x - Math.max(19, r))),
        right: compact ? x + Math.max(19, r) : Math.max(x + r, labelX + labelWidth),
      };
      while (occupied.some((b) => b.row === row && box.left < b.right + 8 && box.right + 8 > b.left)) row++;
      occupied.push({ ...box, row });
      points.push({ ...p, r, x, y: top + row * 50 + 25, labelX, shortLabel: label });
    }
    const height = (Math.max(0, ...occupied.map((b) => b.row)) + 1) * 50;
    lanes.push({ top, height, count: group.length });
    top += height + 20;
  }
  const tickCount = compact ? 3 : 6;
  const ticks = !known.length
    ? []
    : [
        ...new Set(
          Array.from({ length: tickCount }, (_, i) => Math.round(min + ((max - min) * i) / (tickCount - 1))),
        ),
      ].map((year) => ({ year, x: xFor(year) }));
  return {
    points,
    lanes,
    ticks,
    width,
    height: Math.max(260, top + 12),
    compact,
    unknown,
    unknownX: xFor(null),
  };
}
