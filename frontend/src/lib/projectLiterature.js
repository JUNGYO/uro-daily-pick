import { paperTopics, studyMethod } from "./paperTaxonomy";

const list = (value) => (Array.isArray(value) ? value : []);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const referenceKey = (row) => `paper:${row.id}`;

export function referenceStatus(row) {
  if (row.paper?.summary_ready === true) return { id: "summary", label: "본문 기반 요약" };
  if (row.paper?.fulltext_available === true) return { id: "original", label: "원문 확보" };
  return { id: "bibliography", label: "서지 정보 · 원문 미확인" };
}

export function projectReferencePaper(row) {
  return { ...row.bibliography, ...row.paper };
}

export function projectCell(row, columnId, columns = []) {
  const manual = own(row.user_values, columnId);
  return {
    columnId,
    label: columns.find((column) => column.id === columnId)?.label || columnId,
    value: manual ? row.user_values[columnId] : row.auto_values?.[columnId] || "미입력",
    origin: manual ? "사용자 입력" : "자동 정리",
    current: row.extraction_status === "complete" && !!row.source_content_hash,
    // User edits do not inherit the automatic extraction's evidence.
    evidence: manual
      ? []
      : list(row.evidence?.[columnId]).filter((id) => /^(p|figure|table)-\d{7}$/.test(id)),
  };
}

/** A bounded view of the current project's authorized metadata, never a catalog graph. */
export function buildProjectLiterature(references = [], topics = []) {
  const unique = [
    ...new Map(
      list(references)
        .filter((row) => row?.id != null)
        .map((row) => [String(row.id), row]),
    ).values(),
  ];
  const papers = unique.map((reference) => {
    const paper = projectReferencePaper(reference);
    return {
      id: referenceKey(reference),
      kind: "paper",
      label: paper.title || "제목 미등록",
      reference,
      paper,
      status: referenceStatus(reference),
      topics: paperTopics(paper).map((topic) =>
        topic.id === "unclassified" ? { ...topic, label: "미분류" } : topic,
      ),
      method: studyMethod(paper),
    };
  });
  const byReference = new Map(papers.map((paper) => [String(paper.reference.id), paper]));
  const topicNodes = new Map();
  const edges = [];
  const arguments_ = [];
  papers.forEach((paper) => {
    paper.topics
      .filter((topic) => topic.id !== "unclassified")
      .forEach((topic) => {
        const id = `topic:${topic.id}`;
        if (!topicNodes.has(id)) topicNodes.set(id, { ...topic, id, kind: "topic" });
        edges.push({
          id: `${paper.id}:${id}`,
          from: paper.id,
          to: id,
          kind: "classified",
          source: topic.source,
        });
      });
  });
  const seenTopics = new Set();
  list(topics).forEach((topic) => {
    if (topic?.id == null || seenTopics.has(String(topic.id))) return;
    seenTopics.add(String(topic.id));
    const linkedIds = [
      ...new Set(
        [...list(topic.reference_ids), ...list(topic.cell_links).map((cell) => cell.reference_id)].map(
          String,
        ),
      ),
    ];
    const linkedPapers = linkedIds.map((id) => byReference.get(id)).filter(Boolean);
    if (!linkedPapers.length) return;
    const argument = {
      id: `argument:${topic.id}`,
      kind: "argument",
      label: topic.title,
      topic,
      omittedReferences: linkedIds.length - linkedPapers.length,
    };
    arguments_.push(argument);
    linkedPapers.forEach((paper) => {
      edges.push({
        id: `${argument.id}:${paper.id}`,
        from: argument.id,
        to: paper.id,
        kind: "linked",
        cellLinks: list(topic.cell_links).filter(
          (link) => String(link.reference_id) === String(paper.reference.id),
        ),
      });
    });
  });
  const nodes = [...papers, ...arguments_, ...topicNodes.values()];
  return { nodes, edges, papers, byId: new Map(nodes.map((node) => [node.id, node])) };
}

export function literatureDistribution(model, dimension = "topics") {
  const groups = new Map();
  model.papers.forEach((paper) => {
    const values = dimension === "methods" ? [paper.method] : paper.topics;
    new Map(values.map((value) => [value.id, value])).forEach((value) => {
      const group = groups.get(value.id) || {
        ...value,
        label: value.id === "unclassified" ? "미분류" : value.label,
        papers: [],
      };
      group.papers.push(paper);
      groups.set(value.id, group);
    });
  });
  return [...groups.values()].sort((a, b) => {
    if (a.id === "unclassified") return 1;
    if (b.id === "unclassified") return -1;
    return b.papers.length - a.papers.length || a.label.localeCompare(b.label);
  });
}

export function projectNeighbors(model, id) {
  return model.edges
    .filter((edge) => edge.from === id || edge.to === id)
    .map((edge) => ({
      edge,
      node: model.byId.get(edge.from === id ? edge.to : edge.from),
    }))
    .filter((item) => item.node);
}

/** Selecting and expanding exposes one step only. The canvas never exceeds 50 nodes. */
export function projectGraphWindow(model, selectedId, expanded = false) {
  const selected = model.byId.get(selectedId);
  const seedPapers = model.papers.slice(0, 12);
  const seedIds = new Set(seedPapers.map((paper) => paper.id));
  const linked = model.nodes.filter(
    (node) =>
      node.kind === "argument" && model.edges.some((edge) => edge.from === node.id && seedIds.has(edge.to)),
  );
  const classified = model.nodes.filter(
    (node) =>
      node.kind === "topic" && model.edges.some((edge) => edge.to === node.id && seedIds.has(edge.from)),
  );
  const base = [...seedPapers, ...linked.slice(0, 6), ...classified.slice(0, 8), ...model.nodes];
  const neighbors = selected ? projectNeighbors(model, selected.id) : [];
  const ordered = [selected, ...(expanded ? neighbors.map((item) => item.node) : []), ...base].filter(
    Boolean,
  );
  const nodes = [...new Map(ordered.map((node) => [node.id, node])).values()].slice(0, expanded ? 50 : 30);
  const ids = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: model.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    hiddenNeighbors: neighbors.filter((item) => !ids.has(item.node.id)).length,
    totalNodes: model.nodes.length,
  };
}
