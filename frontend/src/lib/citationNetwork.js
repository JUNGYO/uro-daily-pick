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

// Binary reference links alone attract papers. Positions encode neither time,
// similarity nor citation strength. Keep this independent of the concept graph's
// Jaccard weights; citation counts affect disc area only.
function connectionGroup(papers, links, width, height) {
  const ordered = [...papers].sort((a, b) => a.id.localeCompare(b.id));
  const points = ordered.map((p, i) => {
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const radius = 22 * Math.sqrt(i);
    return {
      ...p,
      r: citationRadius(p.incoming_citations ?? p.incomingShown),
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    };
  });
  const byId = new Map(points.map((p) => [p.id, p]));
  const edges = links
    .filter((e) => byId.has(e.source) && byId.has(e.target) && e.source !== e.target)
    .slice()
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  for (let step = 0; step < 420; step++) {
    for (const p of points) {
      p.vx = (p.vx - p.x * 0.004) * 0.65;
      p.vy = (p.vy - p.y * 0.004) * 0.65;
    }
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i],
          b = points[j];
        const dx = b.x - a.x || 0.01,
          dy = b.y - a.y || 0.01;
        const distance = Math.max(0.1, Math.hypot(dx, dy));
        const force = Math.min(12, 350 / distance ** 2 + Math.max(0, a.r + b.r + 24 - distance) * 0.45);
        a.vx -= (dx / distance) * force;
        a.vy -= (dy / distance) * force;
        b.vx += (dx / distance) * force;
        b.vy += (dy / distance) * force;
      }
    for (const e of edges) {
      const a = byId.get(e.source),
        b = byId.get(e.target);
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - a.r - b.r - 42) * 0.035;
      a.vx += (dx / distance) * force;
      a.vy += (dy / distance) * force;
      b.vx -= (dx / distance) * force;
      b.vy -= (dy / distance) * force;
    }
    const cooling = 1 - step / 500;
    for (const p of points) {
      p.x += p.vx * cooling;
      p.y += p.vy * cooling;
    }
  }
  // Fit the whole selected graph, including disc/number padding. Uniform scaling
  // preserves relative disc areas and keeps both ends of every link in view.
  const left = Math.min(0, ...points.map((p) => p.x - p.r - 16));
  const right = Math.max(0, ...points.map((p) => p.x + p.r + 16));
  const top = Math.min(0, ...points.map((p) => p.y - p.r - 22));
  const bottom = Math.max(0, ...points.map((p) => p.y + p.r + 16));
  const padding = Math.min(24, width * 0.12, height * 0.12);
  const scale = Math.min(
    3,
    (width - padding * 2) / Math.max(1, right - left),
    (height - padding * 2) / Math.max(1, bottom - top),
  );
  return {
    scale,
    points: points.map(({ vx, vy, ...p }) => ({
      ...p,
      x: width / 2 + (p.x - (left + right) / 2) * scale,
      y: height / 2 + (p.y - (top + bottom) / 2) * scale,
      r: p.r * scale,
    })),
    width,
    height,
    compact: true,
    lanes: [],
    ticks: [],
    unknown: false,
  };
}

export function citationConnections(papers, links, width = 900) {
  const height = 500;
  const byId = new Map(papers.map((p) => [p.id, p]));
  const adjacent = new Map(papers.map((p) => [p.id, new Set()]));
  for (const e of links) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    adjacent.get(e.source).add(e.target);
    adjacent.get(e.target).add(e.source);
  }
  const seen = new Set(),
    groups = [];
  for (const id of [...byId.keys()].sort()) {
    if (seen.has(id)) continue;
    const ids = [id];
    seen.add(id);
    for (let i = 0; i < ids.length; i++)
      for (const next of [...adjacent.get(ids[i])].sort())
        if (!seen.has(next)) {
          seen.add(next);
          ids.push(next);
        }
    groups.push(ids);
  }
  groups.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  const regions = [];
  // Partition only disconnected components, with area allocated by paper count.
  // There are no invented connecting lines between these separate sets.
  const partition = (sets, x, y, w, h) => {
    if (!sets.length) return;
    if (sets.length === 1) {
      regions.push({ ids: sets[0], x, y, width: w, height: h });
      return;
    }
    const total = sets.reduce((sum, ids) => sum + ids.length, 0);
    let cut = 1,
      count = sets[0].length;
    while (
      cut < sets.length - 1 &&
      Math.abs(count + sets[cut].length - total / 2) < Math.abs(count - total / 2)
    )
      count += sets[cut++].length;
    const fraction = count / total;
    if (w >= h) {
      partition(sets.slice(0, cut), x, y, w * fraction, h);
      partition(sets.slice(cut), x + w * fraction, y, w * (1 - fraction), h);
    } else {
      partition(sets.slice(0, cut), x, y, w, h * fraction);
      partition(sets.slice(cut), x, y + h * fraction, w, h * (1 - fraction));
    }
  };
  partition(groups, 0, 0, width, height);
  const layouts = regions.map((region) => {
    const ids = new Set(region.ids);
    return connectionGroup(
      region.ids.map((id) => byId.get(id)),
      links.filter((e) => ids.has(e.source) && ids.has(e.target)),
      region.width,
      region.height,
    );
  });
  // One shared radius multiplier across components preserves the area encoding.
  const radiusScale = Math.min(1.4, ...layouts.map((g) => g.scale));
  const points = layouts.flatMap((g, i) =>
    g.points.map((p) => ({
      ...p,
      x: p.x + regions[i].x,
      y: p.y + regions[i].y,
      r: citationRadius(p.incoming_citations ?? p.incomingShown) * radiusScale,
    })),
  );
  const compact = width < 580 || points.length > 12;
  if (!compact) {
    const boxes = points.map((p) => ({
      x: p.x - p.r - 5,
      y: p.y - p.r - 19,
      w: p.r * 2 + 10,
      h: p.r * 2 + 24,
    }));
    for (const p of [...points].sort(
      (a, b) => (a.number || 0) - (b.number || 0) || a.id.localeCompare(b.id),
    )) {
      const label = citationLabel(p);
      const text = label.length > 23 ? label.slice(0, 21) + "…" : label;
      const w = text.length * 7,
        h = 18;
      const candidates = [
        { x: p.x + p.r + 9, y: p.y - 9, w, h },
        { x: p.x - p.r - 9 - w, y: p.y - 9, w, h },
        { x: p.x - w / 2, y: p.y + p.r + 8, w, h },
      ];
      const box = candidates.find(
        (b) =>
          b.x >= 8 &&
          b.x + b.w <= width - 8 &&
          b.y >= 8 &&
          b.y + b.h <= height - 8 &&
          !boxes.some(
            (o) => b.x < o.x + o.w + 4 && b.x + b.w + 4 > o.x && b.y < o.y + o.h + 4 && b.y + b.h + 4 > o.y,
          ),
      );
      if (box) {
        boxes.push(box);
        p.labelX = box.x;
        p.labelY = box.y + 13;
        p.shortLabel = text;
      }
    }
  }
  return {
    points,
    regions: regions.length > 1 ? regions : [],
    width,
    height,
    compact,
    lanes: [],
    ticks: [],
    unknown: false,
  };
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
