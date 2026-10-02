// Source locations are Python character offsets; the browser slices UTF-16 strings.
// They locate evidence, never define which text is displayed or where paragraphs end.
export function sourceLocations(text, supplied) {
  if (!Array.isArray(supplied)) return [];
  const candidates = supplied
    .filter(
      (b) =>
        b &&
        /^(p|table|figure)-[0-9]{7}$/.test(b.id) &&
        Number.isInteger(b.start) &&
        Number.isInteger(b.end) &&
        b.start >= 0 &&
        b.end > b.start &&
        b.end <= text.length &&
        typeof b.text === "string",
    )
    .slice(0, 4000);
  let offsets;
  if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text)) {
    const needed = new Set(candidates.flatMap((b) => [b.start, b.end]));
    offsets = new Map();
    let character = 0,
      index = 0;
    for (const value of text) {
      if (needed.has(character)) offsets.set(character, index);
      character++;
      index += value.length;
    }
    if (needed.has(character)) offsets.set(character, index);
  }
  const used = new Set();
  let end = 0;
  return candidates
    .map((b) => ({
      ...b,
      start: offsets ? offsets.get(b.start) : b.start,
      end: offsets ? offsets.get(b.end) : b.end,
    }))
    .sort((a, b) => a.start - b.start)
    .filter((b) => {
      if (
        !Number.isInteger(b.start) ||
        !Number.isInteger(b.end) ||
        b.start < end ||
        used.has(b.id) ||
        b.text.includes("\n") ||
        text.slice(b.start, b.end) !== b.text
      )
        return false;
      used.add(b.id);
      end = b.end;
      return true;
    });
}

export function readingLayout(text, contentHash, value) {
  if (
    !value ||
    value.version !== 1 ||
    value.content_hash !== contentHash ||
    !Array.isArray(value.blocks) ||
    value.blocks.length > 20000
  )
    return null;
  const spans = value.blocks.flatMap((b) => [b, ...(Array.isArray(b?.rows) ? b.rows.flat() : [])]);
  if (
    spans.length > 100000 ||
    spans.some(
      (s) =>
        !s ||
        !Number.isInteger(s.start) ||
        !Number.isInteger(s.end) ||
        s.start < 0 ||
        s.end < s.start ||
        s.end > text.length,
    )
  )
    return null;
  const rawCitations =
    value.citation_version === 1 && Array.isArray(value.citations) && value.citations.length <= 10000
      ? value.citations
      : [];
  const needed = new Set([...spans, ...rawCitations].filter(Boolean).flatMap((s) => [s.start, s.end]));
  const offsets = new Map();
  let character = 0,
    index = 0;
  for (const c of text) {
    if (needed.has(character)) offsets.set(character, index);
    character++;
    index += c.length;
  }
  if (needed.has(character)) offsets.set(character, index);
  const convert = (s) => ({ ...s, start: offsets.get(s.start), end: offsets.get(s.end) });
  let cursor = 0;
  const blocks = [];
  for (const raw of value.blocks) {
    const block = convert(raw);
    if (
      !["heading", "paragraph", "table", "figure"].includes(block.kind) ||
      !Number.isInteger(block.start) ||
      !Number.isInteger(block.end) ||
      block.start < cursor ||
      block.end <= block.start ||
      text.slice(cursor, block.start).trim()
    )
      return null;
    if (block.kind === "table" && raw.rows) {
      if (!Array.isArray(raw.rows) || !raw.rows.length) return null;
      let cellCursor = block.start;
      const rows = [];
      for (const rawRow of raw.rows) {
        if (!Array.isArray(rawRow) || !rawRow.length) return null;
        const row = [];
        for (const rawCell of rawRow) {
          const cell = convert(rawCell);
          if (
            !Number.isInteger(cell.start) ||
            !Number.isInteger(cell.end) ||
            cell.start < cellCursor ||
            cell.end > block.end ||
            text.slice(cellCursor, cell.start).trim() ||
            typeof cell.header !== "boolean" ||
            ["rowspan", "colspan"].some(
              (key) => !Number.isInteger(cell[key]) || cell[key] < 1 || cell[key] > 1000,
            )
          )
            return null;
          row.push(cell);
          cellCursor = cell.end;
        }
        rows.push(row);
      }
      if (text.slice(cellCursor, block.end).trim()) return null;
      block.rows = rows;
    }
    blocks.push(block);
    cursor = block.end;
  }
  if (text.slice(cursor).trim()) return null;
  const references = Array.isArray(value.references)
    ? value.references
        .slice(0, 3000)
        .filter(
          (r) =>
            r &&
            typeof r.id === "string" &&
            /^[A-Za-z0-9_.:-]{1,200}$/.test(r.id) &&
            typeof r.text === "string" &&
            r.text.length > 0 &&
            r.text.length <= 12000,
        )
    : [];
  let citationEnd = 0;
  const citations = [];
  for (const raw of rawCitations) {
    if (!raw) continue;
    const cite = convert(raw);
    if (
      !Number.isInteger(cite.start) ||
      !Number.isInteger(cite.end) ||
      cite.start < citationEnd ||
      cite.end <= cite.start ||
      typeof cite.text !== "string" ||
      text.slice(cite.start, cite.end) !== cite.text ||
      !Array.isArray(cite.targets) ||
      cite.targets.length < 1 ||
      cite.targets.length > 100 ||
      cite.targets.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(id))
    )
      continue;
    citations.push(cite);
    citationEnd = cite.end;
  }
  return { ...value, blocks, citations, references };
}

export function originalParagraphs(text, blocks = [], layout = null) {
  let start = 0,
    blockIndex = 0,
    citationIndex = 0;
  const citations = layout?.citations || [];
  const located = new Set();
  const ranges =
    layout?.blocks ||
    text.split("\n").map((line) => {
      const range = { kind: "paragraph", start, end: start + line.length };
      start = range.end + 1;
      return range;
    });
  const runsFor = (start, end) => {
    const runs = [];
    let cursor = start;
    while (blockIndex < blocks.length && blocks[blockIndex].end <= start) blockIndex++;
    for (let i = blockIndex; i < blocks.length && blocks[i].start < end; i++) {
      const block = blocks[i];
      const from = Math.max(cursor, block.start),
        to = Math.min(end, block.end);
      if (from >= to) continue;
      if (from > cursor) runs.push({ start: cursor, end: from, text: text.slice(cursor, from) });
      runs.push({
        ...block,
        id: located.has(block.id) ? undefined : block.id,
        locationId: block.id,
        start: from,
        end: to,
        text: text.slice(from, to),
      });
      located.add(block.id);
      cursor = to;
    }
    if (cursor < end) runs.push({ start: cursor, end, text: text.slice(cursor, end) });
    while (citationIndex < citations.length && citations[citationIndex].end <= start) citationIndex++;
    const inRange = [];
    for (let i = citationIndex; i < citations.length && citations[i].start < end; i++) {
      // Do not invent partial markers across cells or paragraph boundaries.
      if (citations[i].start >= start && citations[i].end <= end) inRange.push(citations[i]);
    }
    return runs.flatMap((run) => {
      const overlapping = inRange.filter((c) => c.start < run.end && c.end > run.start);
      if (!overlapping.length) return [run];
      const boundaries = [
        ...new Set([
          run.start,
          run.end,
          ...overlapping.flatMap((c) => [Math.max(run.start, c.start), Math.min(run.end, c.end)]),
        ]),
      ].sort((a, b) => a - b);
      return boundaries.slice(0, -1).map((from, i) => ({
        ...run,
        start: from,
        end: boundaries[i + 1],
        id: i === 0 ? run.id : undefined,
        text: text.slice(from, boundaries[i + 1]),
        citation: overlapping.find((c) => c.start <= from && c.end >= boundaries[i + 1]),
      }));
    });
  };
  return ranges.map((range) => {
    const paragraph = { ...range, figures: [] };
    if (range.rows) {
      paragraph.rows = range.rows.map((row) =>
        row.map((cell) => ({ ...cell, runs: runsFor(cell.start, cell.end) })),
      );
    } else {
      paragraph.runs = runsFor(range.start, range.end);
      paragraph.figures = paragraph.runs.filter((r) => r.id?.startsWith("figure-"));
      if (range.kind === "figure" && !paragraph.figures.length)
        paragraph.figures.push({ id: `caption-${range.start}`, text: text.slice(range.start, range.end) });
    }
    return paragraph;
  });
}
