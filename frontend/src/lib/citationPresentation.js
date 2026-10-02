// Display numbering is derived from verified publisher links, never from prose.
// Source text, stored offsets and bibliography identities remain unchanged.
export function numericCitation(text) {
  const value = text.replace(/[\[\]()\uFF08\uFF09\uFF3B\uFF3D\u2022*†‡]/g, "").trim();
  if (!value || !/^[\d\s,;\u2013\u2014-]+$/.test(value)) return null;
  const numbers = [],
    endpoints = [];
  for (const part of value.replace(/\s*([-\u2013\u2014])\s*/g, "$1").split(/[,;\s]+/)) {
    if (!part.trim()) continue;
    const match = part.trim().match(/^(\d{1,5})(?:\s*[-\u2013\u2014]\s*(\d{1,5}))?$/);
    if (!match) return null;
    const from = Number(match[1]),
      to = Number(match[2] || match[1]);
    if (from < 1 || to < from || to - from > 99) return null;
    endpoints.push(from, to);
    for (let n = from; n <= to; n++) numbers.push(n);
    if (numbers.length > 100) return null;
  }
  return numbers.length ? { numbers: [...new Set(numbers)], endpoints: [...new Set(endpoints)] } : null;
}

export function compactCitationNumbers(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b),
    parts = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    if (j - i >= 2) parts.push(`${sorted[i]}–${sorted[j]}`);
    else parts.push(...sorted.slice(i, j + 1).map(String));
    i = j;
  }
  return parts.join(", ");
}

function wrappedRange(text, cite, minimum, maximum) {
  let { start, end } = cite,
    wrapped = false;
  const pairs = { "[": "]", "(": ")", "［": "］", "（": "）" };
  // Only absorb balanced wrappers immediately around a verified citation.
  while (true) {
    let left = start,
      right = end;
    while (left > minimum && /\s/.test(text[left - 1])) left--;
    while (right < maximum && /\s/.test(text[right])) right++;
    if (left <= minimum || right >= maximum || pairs[text[left - 1]] !== text[right]) break;
    start = left - 1;
    end = right + 1;
    wrapped = true;
  }
  const original = text.slice(start, end).trim();
  wrapped ||= pairs[original[0]] === original.at(-1);
  let punctuation = end;
  while (punctuation < maximum && /\s/.test(text[punctuation])) punctuation++;
  if (punctuation < maximum && /[.,;:!?]/.test(text[punctuation])) end = punctuation;
  return { ...cite, start, end, text: text.slice(start, end), wrapped };
}

function bibliographyText(text, labels) {
  if (!text) return null;
  // Remove a publisher's list number only when linked markers confirm it.
  const match = text.match(/^\s*(?:\[(\d+)\]|\((\d+)\)|(\d+)\s*[.)]?)(?:\s+|(?=[A-Z]))/);
  return match && labels?.has(Number(match[1] || match[2] || match[3])) ? text.slice(match[0].length) : text;
}

export function citationPresentation(text, layout) {
  if (!layout?.citations?.length) return layout;
  const references = new Map((layout.references || []).map((ref) => [ref.id, ref]));
  const aliasCandidates = new Map(),
    sourceLabels = new Map();
  const analyses = layout.citations.map((cite) => {
    const numeric = numericCitation(cite.text),
      targets = [...new Set(cite.targets)];
    const labels =
      numeric &&
      (numeric.numbers.length === targets.length
        ? numeric.numbers
        : numeric.endpoints.length === targets.length
          ? numeric.endpoints
          : null);
    if (labels)
      targets.forEach((id, i) => {
        if (!aliasCandidates.has(labels[i])) aliasCandidates.set(labels[i], new Set());
        aliasCandidates.get(labels[i]).add(id);
        if (!sourceLabels.has(id)) sourceLabels.set(id, new Set());
        sourceLabels.get(id).add(labels[i]);
      });
    return { ...cite, numeric, targets, labels };
  });
  const aliases = new Map(
    [...aliasCandidates].filter(([, ids]) => ids.size === 1).map(([number, ids]) => [number, [...ids][0]]),
  );
  const numbered = new Map();
  const entry = (id, sourceNumber) => {
    const key = id ? `id:${id}` : `source-number:${sourceNumber}`;
    if (!numbered.has(key))
      numbered.set(key, {
        key,
        id,
        number: numbered.size + 1,
        text: bibliographyText(references.get(id)?.text, sourceLabels.get(id)),
      });
    return numbered.get(key);
  };
  const blocks = layout.blocks.flatMap((b) => (b.rows ? b.rows.flat() : [b]));
  let blockIndex = 0;
  const citations = analyses.map((cite, i) => {
    while (blockIndex < blocks.length && blocks[blockIndex].end <= cite.start) blockIndex++;
    const block = blocks[blockIndex];
    const minimum = Math.max(block?.start ?? 0, analyses[i - 1]?.end ?? 0);
    const maximum = Math.min(block?.end ?? text.length, analyses[i + 1]?.start ?? text.length);
    const range = wrappedRange(text, cite, minimum, maximum);
    const entries = cite.labels
      ? cite.numeric.numbers.map((n) => {
          const index = cite.labels.indexOf(n);
          // Explicit publisher targets win; range interiors may be linked by another
          // occurrence in this article, otherwise retain an honest missing entry.
          return entry(index >= 0 ? cite.targets[index] : aliases.get(n), n);
        })
      : cite.targets.map((id) => entry(id));
    const unique = [...new Map(entries.map((r) => [r.key, r])).values()].sort((a, b) => a.number - b.number);
    // A narrative "Smith et al. (2024) showed..." needs its subject preserved.
    // Parenthetical author/year groups are replaced entirely by their markers.
    let prefix = "";
    if (!cite.numeric && !range.wrapped && cite.targets.length === 1) {
      const narrative = cite.text.match(/^(.+?)\s*(?:,\s*|\(\s*)(?:18|19|20)\d{2}[a-z]?\s*\)?\s*$/u);
      if (narrative) prefix = narrative[1].trim() + " ";
    }
    return { ...range, entries: unique, prefix, label: compactCitationNumbers(unique.map((r) => r.number)) };
  });
  return { ...layout, citations };
}
