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
  const needed = new Set(spans.flatMap((s) => [s.start, s.end]));
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
  return text.slice(cursor).trim() ? null : { ...value, blocks };
}

export function originalParagraphs(text, blocks = [], layout = null) {
  let start = 0,
    blockIndex = 0;
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
      if (from > cursor) runs.push({ text: text.slice(cursor, from) });
      runs.push({
        ...block,
        id: located.has(block.id) ? undefined : block.id,
        locationId: block.id,
        text: text.slice(from, to),
      });
      located.add(block.id);
      cursor = to;
    }
    if (cursor < end) runs.push({ text: text.slice(cursor, end) });
    return runs;
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
