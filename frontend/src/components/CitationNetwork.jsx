import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Download, Minus, Plus, RotateCcw, X } from "lucide-react";
import {
  citationConnections,
  citationLabel,
  citationModel,
  citationNeighborhood,
  citationTimeline,
} from "../lib/citationNetwork";
import { networkSnapshot } from "../lib/researchNetwork";

function PaperLink({ paper }) {
  if (paper.in_catalog && paper.pmid)
    return (
      <Link to={`/papers/${paper.pmid}`}>
        Open paper <ArrowUpRight size={14} />
      </Link>
    );
  if (paper.pmid)
    return (
      <a href={`https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`} target="_blank" rel="noreferrer">
        View on PubMed <ArrowUpRight size={14} />
      </a>
    );
  if (paper.doi)
    return (
      <a href={`https://doi.org/${encodeURIComponent(paper.doi)}`} target="_blank" rel="noreferrer">
        Open DOI <ArrowUpRight size={14} />
      </a>
    );
  return null;
}

export default function CitationNetwork({
  data,
  selected,
  peer,
  select,
  selectEdge,
  limit,
  setLimit,
  page,
  setPage,
}) {
  const { papers, links } = useMemo(() => citationModel(data.nodes, data.edges), [data.nodes, data.edges]);
  const [width, setWidth] = useState(760),
    [zoom, setZoom] = useState(1),
    [hover, setHover] = useState(null);
  const [direction, setDirection] = useState("all"),
    [focusOnly, setFocusOnly] = useState(true);
  const [showUnlinked, setShowUnlinked] = useState(false);
  const [view, setView] = useState("connections");
  const isTimeline = view === "timeline";
  const canvas = useRef(null),
    marker = useId().replaceAll(":", "");
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const resize = () => setWidth(Math.max(240, Math.floor(el.clientWidth)));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setDirection("all");
  }, [selected]);
  useEffect(() => {
    setZoom(1);
    setHover(null);
    canvas.current?.scrollTo({ top: 0, left: 0 });
  }, [selected, peer, focusOnly, view]);
  const neighborhood = citationNeighborhood(papers, links, selected);
  const displayIds = new Set([selected, peer, ...neighborhood.map((p) => p.id)]);
  const displayed = selected && focusOnly ? papers.filter((p) => displayIds.has(p.id)) : papers;
  const displayedIds = new Set(displayed.map((p) => p.id));
  const displayedLinks = links.filter((e) => displayedIds.has(e.source) && displayedIds.has(e.target));
  const layout = useMemo(
    () =>
      isTimeline
        ? citationTimeline(displayed, displayedLinks, width * zoom)
        : citationConnections(displayed, displayedLinks, Math.max(480, width)),
    [papers, links, selected, peer, focusOnly, width, zoom, isTimeline],
  );
  const byId = new Map(layout.points.map((p) => [p.id, p]));
  const selection = data.citation_selection?.length
    ? data.citation_selection
    : papers.filter((p) => p.id === selected || p.id === peer);
  const focal = selection.find((n) => n.id === selected);
  const visibleList =
    selected && direction !== "all"
      ? citationNeighborhood(papers, links, selected, direction)
      : selected && focusOnly
        ? neighborhood
        : papers;
  const refs =
    focal?.identified_references ?? citationNeighborhood(papers, links, selected, "references").length;
  const cited = focal?.incoming_citations ?? citationNeighborhood(papers, links, selected, "cited-by").length;
  const coverage = data.coverage || {};
  const activate = (e, fn) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
  const download = () => {
    const snapshot = networkSnapshot(data);
    snapshot.method.layout = isTimeline
      ? "linear publication-year axis; vertical connected groups are navigation lanes, not a measurement"
      : "deterministic layout attracted by binary identified references; positions are not years, similarity or evidence strength";
    snapshot.display = {
      view,
      focus: selected || null,
      focus_only: Boolean(selected && focusOnly),
      node_ids: displayed.map((p) => p.id),
      edge_count: displayedLinks.length,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "research-network.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const row = (n, unlinked = false) => (
    <li key={n.id}>
      <button className="citation-paper-button" aria-pressed={selected === n.id} onClick={() => select(n.id)}>
        <span className="citation-paper-number">{unlinked ? "—" : n.number}</span>
        <span className="citation-paper-copy">
          <strong>{n.label}</strong>
          <span>
            {citationLabel(n)}
            {n.journal ? ` · ${n.journal}` : ""}
          </span>
          <small>
            {selected && links.some((e) => e.source === selected && e.target === n.id) ? "Reference · " : ""}
            {selected && links.some((e) => e.target === selected && e.source === n.id)
              ? "Cites selected paper · "
              : ""}
            {n.incoming_citations ?? n.incomingShown ?? 0} citations in filtered corpus
          </small>
        </span>
      </button>
    </li>
  );
  return (
    <div className="citation-workspace">
      <div className="citation-main">
        <div className="network-options">
          <label>
            Paper limit{" "}
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[30, 60, 100].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button onClick={download}>
            <Download size={15} />
            Export data
          </button>
        </div>
        <div className="network-coverage">
          <strong>
            {papers.length} / {coverage.citation_nodes ?? data.matched_documents} papers and references
          </strong>
          <span>
            {links.length} links loaded · {displayedLinks.length} shown
          </span>
        </div>
        <div className="citation-map-heading">
          <div>
            <h3>{isTimeline ? "Citation timeline" : "Citation map"}</h3>
            <p>
              {isTimeline
                ? "Publication year → · Connected groups"
                : "Follow a paper’s references and citing papers"}
            </p>
          </div>
          <div className="citation-zoom">
            <button
              aria-label="Zoom out"
              disabled={zoom <= 1}
              onClick={() => setZoom(Math.max(1, zoom - 0.5))}
            >
              <Minus size={16} />
            </button>
            <button
              aria-label="Zoom in"
              disabled={zoom >= 3}
              onClick={() => setZoom(Math.min(3, zoom + 0.5))}
            >
              <Plus size={16} />
            </button>
            <button
              aria-label="Reset graph view"
              onClick={() => {
                setZoom(1);
                canvas.current?.scrollTo({ top: 0, left: 0 });
              }}
            >
              <RotateCcw size={16} />
            </button>
          </div>
        </div>
        <div className="citation-view-controls" role="group" aria-label="Citation layout">
          <button aria-pressed={!isTimeline} onClick={() => setView("connections")}>
            Connections
          </button>
          <button aria-pressed={isTimeline} onClick={() => setView("timeline")}>
            Publication timeline
          </button>
          <span>
            {isTimeline ? "Years on the horizontal axis" : "Position follows links, not publication year"}
          </span>
        </div>
        {selected && (
          <div className="citation-focus-controls">
            <label>
              <input type="checkbox" checked={focusOnly} onChange={(e) => setFocusOnly(e.target.checked)} />{" "}
              Selected connections only
            </label>
            <button onClick={() => select(null)}>
              <X size={14} />
              Clear selection
            </button>
          </div>
        )}
        {!links.length && (
          <p className="network-notice">
            {!coverage.metadata_papers
              ? "Reference metadata has not been retrieved for this selection."
              : !coverage.reference_identifiers
                ? "Retrieved metadata contains no reference identifiers."
                : "No identified links are available for this selection."}{" "}
            This does not mean these papers have no citations.
          </p>
        )}
        <div
          className={`citation-canvas${isTimeline ? "" : " citation-connections-canvas"}`}
          ref={canvas}
          role="region"
          aria-label={isTimeline ? "Citation timeline canvas" : "Citation map canvas"}
          tabIndex={0}
        >
          <svg
            width={isTimeline ? layout.width : width * zoom}
            height={isTimeline ? layout.height : (width < 580 ? 300 : 500) * zoom}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="group"
            aria-label="Citation network from reference identifiers"
          >
            <defs>
              <marker
                id={marker}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10Z" fill="#657b95" />
              </marker>
            </defs>
            {layout.regions?.map((region, i) => (
              <rect
                key={i}
                x={region.x + 3}
                y={region.y + 3}
                width={Math.max(0, region.width - 6)}
                height={Math.max(0, region.height - 6)}
                rx="12"
                fill="#f8fafc"
                stroke="#e7edf3"
              >
                <title>{region.ids.length} papers in one connected set</title>
              </rect>
            ))}
            {layout.lanes.map((l, i) => (
              <rect
                key={i}
                x="4"
                y={l.top}
                width={layout.width - 8}
                height={l.height}
                rx="10"
                fill={i % 2 ? "#f1f5f9" : "#f8fafc"}
              />
            ))}
            {layout.ticks.map((t) => (
              <g key={t.year}>
                <line
                  x1={t.x}
                  x2={t.x}
                  y1="36"
                  y2={layout.height - 8}
                  stroke="#dce4ed"
                  strokeDasharray="3 5"
                />
                <text className="citation-axis" x={t.x} y="24" textAnchor="middle">
                  {t.year}
                </text>
              </g>
            ))}
            {layout.unknown && (
              <text
                className="citation-axis"
                x={layout.unknownX}
                y={layout.compact ? 42 : 24}
                textAnchor="end"
              >
                No year
              </text>
            )}
            {displayedLinks.map((e) => {
              const a = byId.get(e.source),
                b = byId.get(e.target);
              if (!a || !b) return null;
              const active = peer
                ? e.source === selected && e.target === peer
                : [selected, hover].some((id) => id && (id === e.source || id === e.target));
              // Arrows terminate outside the target disc. Same-year links bend
              // sideways; chronology is never fabricated to straighten an edge.
              const sameYear = isTimeline && Math.abs(a.x - b.x) < 2;
              const dx = b.x - a.x,
                dy = b.y - a.y,
                distance = Math.max(1, Math.hypot(dx, dy));
              const path = sameYear
                ? `M${a.x + a.r + 2},${a.y} C${Math.min(layout.width - 3, a.x + 55)},${a.y} ${Math.min(layout.width - 3, b.x + 55)},${b.y} ${b.x + b.r + 5},${b.y}`
                : `M${a.x + (dx * (a.r + 2)) / distance},${a.y + (dy * (a.r + 2)) / distance} L${b.x - (dx * (b.r + 5)) / distance},${b.y - (dy * (b.r + 5)) / distance}`;
              const label = `${a.label} cites ${b.label}`;
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
                  <path
                    d={path}
                    fill="none"
                    stroke={active ? "#244fb4" : "#607d98"}
                    strokeWidth={active ? 2.5 : 1.5}
                    opacity={hover && !active ? 0.18 : 0.85}
                    markerEnd={`url(#${marker})`}
                  />
                  <path d={path} fill="none" stroke="transparent" strokeWidth="14" />
                </g>
              );
            })}
            {layout.points.map((p) => (
              <g
                key={p.id}
                className="citation-node"
                role="button"
                tabIndex={0}
                aria-label={`Select paper ${p.number}: ${p.label}`}
                aria-pressed={selected === p.id}
                onClick={() => select(p.id)}
                onKeyDown={(e) => activate(e, () => select(p.id))}
                onMouseEnter={() => setHover(p.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(p.id)}
                onBlur={() => setHover(null)}
              >
                <title>
                  {citationLabel(p)}: {p.label}
                </title>
                <circle cx={p.x} cy={p.y} r={Math.max(20, p.r)} fill="transparent" />
                <circle
                  className="citation-disc"
                  cx={p.x}
                  cy={p.y}
                  r={p.r}
                  fill={p.matching_source === false ? "#b45c38" : "#2766aa"}
                  stroke={selected === p.id || peer === p.id ? "#142b4b" : "white"}
                  strokeWidth={selected === p.id || peer === p.id ? 3 : 1.5}
                />
                <text className="citation-number" x={p.x} y={p.y - p.r - 5} textAnchor="middle">
                  {p.number}
                </text>
                {!layout.compact && p.shortLabel && (
                  <text className="citation-label" x={p.labelX} y={p.labelY ?? p.y + 4}>
                    {p.shortLabel.length > 23 ? p.shortLabel.slice(0, 21) + "…" : p.shortLabel}
                  </text>
                )}
              </g>
            ))}
          </svg>
        </div>
        <div className="citation-legend">
          <span>
            <i />
            Matching source
          </span>
          <span>
            <i className="citation-reference-key" />
            Reference outside filters
          </span>
          <span>Numbers match the paper list</span>
        </div>
        <p className="atlas-graph-note">
          Arrows follow identified references: citing paper → referenced paper. Circle area = 1 + citations
          from the filtered indexed corpus (capped at 20 citations). Not global citation counts.
        </p>
        <details className="network-method">
          <summary>Methods & coverage</summary>
          <p>
            {coverage.metadata_papers ?? 0} of {data.matched_documents} matching papers have retrieved
            metadata; {coverage.papers_with_reference_ids ?? 0} contain reference identifiers. Reference lists
            may be incomplete.
          </p>
          <p>
            The connections view brings papers together using identified links only; positions do not measure
            time, similarity or evidence strength. The publication timeline uses catalog publication years;
            missing years stay in a separate lane. Vertical lanes group connected papers for navigation.
            Filters select citing indexed papers; their references may be older or outside the indexed corpus.
          </p>
          <p>
            Connected endpoints are selected together, prioritizing the selected paper and frequently cited
            targets. The paper limit and 500-link limit bound this view. Counts cover all identified links
            from matching source papers, including links outside the display. Reference targets do not require
            indexed full text. Citations do not establish agreement or research quality.
          </p>
        </details>
        {(coverage.unlinked_papers > 0 || data.unlinked_papers?.length > 0) && (
          <details
            className="citation-unlinked"
            open={showUnlinked}
            onToggle={(e) => setShowUnlinked(e.currentTarget.open)}
          >
            <summary>
              {coverage.unlinked_papers ?? data.unlinked_papers.length} papers without identified links in
              this filtered corpus
            </summary>
            <p>Kept in the library. Missing reference metadata can prevent a connection from appearing.</p>
            <ul className="citation-paper-list">{(data.unlinked_papers || []).map((n) => row(n, true))}</ul>
            <div className="citation-unlinked-pages">
              <button disabled={!page} onClick={() => setPage(page - 1)}>
                Previous unlinked papers
              </button>
              <span>Page {page + 1}</span>
              <button
                disabled={(page + 1) * 20 >= coverage.unlinked_papers}
                onClick={() => setPage(page + 1)}
              >
                Next unlinked papers
              </button>
            </div>
          </details>
        )}
      </div>
      <aside className="citation-reading-panel" aria-label="Selected research">
        {focal ? (
          <div className="citation-selection" aria-live="polite">
            <span className="atlas-eyebrow">{peer ? "IDENTIFIED CITATION" : "SELECTED PAPER"}</span>
            {selection.map((p, i) => (
              <section key={p.id}>
                {peer && <small>{i === 0 ? "Citing paper" : "Referenced paper"}</small>}
                <h3>{p.label}</h3>
                <p>
                  {citationLabel(p)}
                  {p.journal ? ` · ${p.journal}` : ""}
                </p>
                <p>
                  {p.matching_source === false
                    ? "Reference metadata · Outside the matching indexed papers"
                    : "Indexed full text"}
                </p>
                <PaperLink paper={p} />
                {p.integrity_status && p.integrity_status !== "current" && (
                  <p>Publication status: {p.integrity_status}</p>
                )}
              </section>
            ))}
            <div className="citation-counts">
              <span>
                <b>{focal.matching_source === false ? "—" : refs}</b>{" "}
                {focal.matching_source === false
                  ? "reference list outside this view"
                  : "identified references"}
              </span>
              <span>
                <b>{cited}</b> citations in filtered corpus
              </span>
            </div>
            <p className="citation-scope">
              Reference lists outside the matching source papers are not retrieved in this view. These counts
              are incomplete coverage, not evidence of no references.
            </p>
          </div>
        ) : (
          <div className="citation-list-heading">
            <span className="atlas-eyebrow">FOLLOW THE LITERATURE</span>
            <h3>Papers on the map</h3>
            <p>Select a paper to follow its references and the indexed papers that cite it.</p>
          </div>
        )}
        {selected && (
          <div className="citation-list-tabs" aria-label="Citation direction">
            {[
              ["all", "Connected"],
              ["references", "References"],
              ["cited-by", "Cited by"],
            ].map(([value, label]) => (
              <button key={value} aria-pressed={direction === value} onClick={() => setDirection(value)}>
                {label}
              </button>
            ))}
          </div>
        )}
        <p className="citation-list-count">
          {visibleList.length} papers listed
          {selected ? " from the displayed selection" : " · Most cited in filtered corpus first"}
        </p>
        {!visibleList.length && (
          <p className="citation-list-empty">
            No papers shown for this direction. Increase the paper limit or broaden the filters. Coverage is
            incomplete.
          </p>
        )}
        <ul className="citation-paper-list">{visibleList.map((n) => row(n))}</ul>
      </aside>
    </div>
  );
}
