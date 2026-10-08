import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Download, List, Minus, Plus, RotateCcw } from "lucide-react";
import {
  CATEGORY_LABELS,
  categoryColor,
  edgeWidth,
  networkLayout,
  networkSnapshot,
} from "../lib/researchNetwork";

export default function ResearchNetwork({
  data,
  selected,
  peer,
  select,
  selectEdge,
  minimum,
  setMinimum,
  limit,
  setLimit,
}) {
  const [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [list, setList] = useState(false);
  const [hover, setHover] = useState(null);
  const drag = useRef(null),
    marker = useId().replaceAll(":", "");
  const canvas = useRef(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const center = () => {
      element.scrollLeft = Math.max(0, (element.scrollWidth - element.clientWidth) / 2);
    };
    center();
    const observer = new ResizeObserver(center);
    observer.observe(element);
    return () => observer.disconnect();
  }, [list]);
  const points = useMemo(() => networkLayout(data.nodes, data.edges), [data.nodes, data.edges]);
  const byId = new Map(points.map((p) => [p.id, p]));
  const citations = data.relationship === "citations",
    coverage = data.coverage;
  const related = new Set(
    data.edges.flatMap((e) => (e.source === selected ? [e.target] : e.target === selected ? [e.source] : [])),
  );
  // Labels occupy separate screen regions. Hidden labels remain available by
  // keyboard, pointer and the complete list; no nodes or links are dropped.
  const occupied = [];
  const labels = new Map();
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const circles = points.map((p) => ({
    id: p.id,
    x: p.x - p.r - 4,
    y: p.y - p.r - 4,
    w: 2 * p.r + 8,
    h: 2 * p.r + 8,
  }));
  for (const p of [...points].sort(
    (a, b) =>
      Number(b.id === selected || b.id === hover) - Number(a.id === selected || a.id === hover) ||
      Number(b.document_count) - Number(a.document_count) ||
      a.id.localeCompare(b.id),
  )) {
    const w = Math.min(218, p.label.length * 7.5),
      h = 20;
    const candidates = [
      { x: p.x - w / 2, y: p.y + p.r + 7, w, h },
      { x: p.x - w / 2, y: p.y - p.r - h - 7, w, h },
      { x: p.x + p.r + 7, y: p.y - h / 2, w, h },
      { x: p.x - p.r - w - 7, y: p.y - h / 2, w, h },
    ];
    const box = candidates.find(
      (b) =>
        b.x >= 5 &&
        b.x + b.w <= 995 &&
        b.y >= 5 &&
        b.y + b.h <= 675 &&
        !occupied.some((a) => overlaps(a, b)) &&
        !circles.some((a) => a.id !== p.id && overlaps(a, b)),
    );
    if (box) {
      labels.set(p.id, { x: box.x + w / 2, y: box.y + 15 });
      occupied.push(box);
    }
  }
  const exportData = () => {
    const blob = new Blob([JSON.stringify(networkSnapshot(data), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "research-network.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const activate = (e, fn) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
  return (
    <div className="research-network">
      <div className="network-options">
        {!citations && (
          <label>
            Shared papers{" "}
            <select
              aria-label="Minimum shared papers"
              value={minimum}
              onChange={(e) => setMinimum(Number(e.target.value))}
            >
              {[1, 2, 3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n} or more
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Node limit{" "}
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[30, 60, 100].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <button onClick={exportData}>
          <Download size={15} />
          Export data
        </button>
      </div>
      <div className="network-coverage">
        <strong>
          {data.nodes.length} / {citations ? data.matched_documents : coverage.concepts}{" "}
          {citations ? "papers" : "concepts"}
        </strong>
        <span>
          {data.edges.length} links shown
          {!citations && coverage.links_at_threshold > data.edges.length
            ? ` of ${coverage.links_at_threshold} at this threshold`
            : ""}
        </span>
      </div>
      {citations && !data.edges.length && (
        <div className="network-notice">
          {!coverage.metadata_papers
            ? "Reference metadata has not been retrieved for these papers."
            : !coverage.reference_identifiers
              ? "Retrieved metadata contains no reference identifiers. Citation coverage is incomplete."
              : "No identified citations connect papers within this displayed subset."}{" "}
          This does not mean that the papers have no citations.
        </div>
      )}
      {!citations && !data.edges.length && (
        <div className="network-notice">No concept pairs meet this threshold in the displayed subset.</div>
      )}
      <div className="atlas-graph-toolbar">
        <span>{citations ? "Citation network" : "Concept co-occurrence"}</span>
        <div>
          <button
            aria-label={list ? "Show graph" : "Show accessible concept list"}
            aria-pressed={list}
            onClick={() => setList(!list)}
          >
            <List size={17} />
          </button>
          <button
            aria-label="Zoom out"
            disabled={zoom <= 0.75}
            onClick={() => setZoom((z) => Math.max(0.75, z - 0.25))}
          >
            <Minus size={17} />
          </button>
          <button
            aria-label="Zoom in"
            disabled={zoom >= 3}
            onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
          >
            <Plus size={17} />
          </button>
          <button
            aria-label="Reset graph view"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            <RotateCcw size={17} />
          </button>
        </div>
      </div>
      {list ? (
        <ul className="atlas-node-list">
          {data.nodes.map((n) => (
            <li key={n.id}>
              <button aria-pressed={selected === n.id} onClick={() => select(n.id)}>
                <i style={{ background: categoryColor(n.kind) }} />
                <span>
                  {n.label}
                  <small>{CATEGORY_LABELS[n.kind] || "Unclassified"}</small>
                </span>
                <small>{citations ? n.year : `${n.document_count} papers`}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div
          ref={canvas}
          className="network-canvas-scroll"
          tabIndex={0}
          role="region"
          aria-label="Scrollable network canvas"
        >
          <svg
            className="atlas-graph scientific-network"
            viewBox="0 0 1000 680"
            role="group"
            aria-label={
              citations ? "Citation network from reference identifiers" : "Concept map from full texts"
            }
            onPointerDown={(e) => {
              if (e.target.closest('[role="button"]')) return;
              drag.current = { x: e.clientX, y: e.clientY, pan };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              const scale = 1000 / e.currentTarget.getBoundingClientRect().width;
              setPan({
                x: Math.max(-850, Math.min(850, drag.current.pan.x + (e.clientX - drag.current.x) * scale)),
                y: Math.max(-550, Math.min(550, drag.current.pan.y + (e.clientY - drag.current.y) * scale)),
              });
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <defs>
              <marker
                id={marker}
                viewBox="0 0 10 10"
                refX="10"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10Z" fill="#64748b" />
              </marker>
            </defs>
            <g transform={`translate(${500 + pan.x} ${340 + pan.y}) scale(${zoom}) translate(-500 -340)`}>
              {data.edges.map((e) => {
                const a = byId.get(e.source),
                  b = byId.get(e.target);
                if (!a || !b) return null;
                const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
                  offset = b.r + 4;
                const position = {
                  x1: a.x,
                  y1: a.y,
                  x2: b.x - ((b.x - a.x) * offset) / distance,
                  y2: b.y - ((b.y - a.y) * offset) / distance,
                };
                const active = peer
                  ? [selected, peer].includes(e.source) && [selected, peer].includes(e.target)
                  : e.source === selected || e.target === selected;
                const label = citations
                  ? `${a.label} cites ${b.label}`
                  : `${a.label} and ${b.label}: ${e.weight} shared papers`;
                return (
                  <g
                    key={`${e.source}:${e.target}`}
                    className="network-edge"
                    role="button"
                    tabIndex={0}
                    aria-label={label}
                    aria-pressed={active}
                    onClick={() => selectEdge(e.source, e.target)}
                    onKeyDown={(event) => activate(event, () => selectEdge(e.source, e.target))}
                  >
                    <title>{label}</title>
                    <line
                      {...position}
                      stroke={active ? "#244fb4" : "#8294ae"}
                      strokeOpacity={selected && !active ? 0.16 : active ? 0.9 : 0.38}
                      strokeWidth={edgeWidth(e.weight)}
                      markerEnd={citations ? `url(#${marker})` : undefined}
                    />
                    <line {...position} stroke="transparent" strokeWidth="14" />
                  </g>
                );
              })}
              {points.map((p) => (
                <g
                  key={p.id}
                  className="atlas-node network-node"
                  role="button"
                  tabIndex={0}
                  aria-label={`${p.label}, ${citations ? `published ${p.year}` : `${p.document_count} papers, ${CATEGORY_LABELS[p.kind] || "Unclassified"}`}`}
                  aria-pressed={selected === p.id || peer === p.id}
                  onClick={() => select(p.id)}
                  onKeyDown={(e) => activate(e, () => select(p.id))}
                  onMouseEnter={() => setHover(p.id)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(p.id)}
                  onBlur={() => setHover(null)}
                >
                  <title>{p.label}</title>
                  <circle cx={p.x} cy={p.y} r={Math.max(22, p.r)} fill="transparent" />
                  <circle
                    className="network-node-disc"
                    cx={p.x}
                    cy={p.y}
                    r={p.r}
                    fill={categoryColor(p.kind)}
                    opacity={!selected || selected === p.id || peer === p.id || related.has(p.id) ? 1 : 0.32}
                    stroke={selected === p.id || peer === p.id ? "#152b4b" : "white"}
                    strokeWidth={selected === p.id || peer === p.id ? 3 : 1.5}
                  />
                  {labels.has(p.id) && (
                    <text x={labels.get(p.id).x} y={labels.get(p.id).y} textAnchor="middle">
                      {p.label.length > 29 ? p.label.slice(0, 27) + "…" : p.label}
                    </text>
                  )}
                </g>
              ))}
            </g>
          </svg>
        </div>
      )}
      <p className="network-navigation">
        Drag to pan · Use + / − to zoom · Select a node or connection. All displayed nodes are available on
        every screen size.
      </p>
      <div className="network-legend">
        {[...new Set(data.nodes.map((n) => n.kind))].sort().map((k) => (
          <span key={k}>
            <i style={{ background: categoryColor(k) }} />
            {CATEGORY_LABELS[k] || "Unclassified"}
          </span>
        ))}
      </div>
      <p className="atlas-graph-note">
        {citations
          ? "Arrows follow identified references: citing paper → referenced paper. Only links within this subset are shown."
          : "Circle area = distinct papers · Line width = log-scaled shared-paper count · Color = MeSH category. Position is a navigation aid, not a measured scientific distance."}
      </p>
      <details className="network-method">
        <summary>Methods & coverage</summary>
        <p>
          {citations
            ? `${coverage.metadata_papers} of ${data.matched_documents} matching papers have retrieved metadata; ${coverage.papers_with_reference_ids} contain reference identifiers. Reference lists may be incomplete.`
            : `${coverage.resolved} of ${coverage.concepts} concepts have an exact, unambiguous MeSH mapping. Unmapped terms remain unclassified. Synonyms with the same MeSH concept identifier count once per paper.`}
        </p>
        <p>
          {citations
            ? "Nodes are the newest matching papers, with your selection retained."
            : "Nodes are selected by paper count, with your selection retained. Links require the selected minimum shared-paper count and are capped at 500. Jaccard overlap = shared papers ÷ papers containing either concept. The layout uses overlap to arrange nodes; distances are not calibrated."}
        </p>
        <p>
          Counts describe indexed papers, not independent studies, clinical effect, research quality or
          consensus. Missing full texts, indexing coverage and publication year filters affect this view.
          Exports include the displayed nodes, links, filters and counting rules.
        </p>
      </details>
    </div>
  );
}
