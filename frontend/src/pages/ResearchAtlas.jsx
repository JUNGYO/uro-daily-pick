import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Network,
  Search,
  SlidersHorizontal,
  ArrowUpRight,
  RotateCcw,
  Plus,
  Minus,
  X,
  List,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { rpc } from "../lib/workspace";
import { Resource, useResource } from "../components/ReaderUI";
import { ENGLISH_RESOURCE, KnowledgeNarrative, ScientificPaper } from "../components/KnowledgeEvidence";
import "../knowledge.css";

const TYPES = {
  condition: "Condition",
  intervention: "Treatment / procedure",
  test: "Test",
  outcome: "Outcome",
  method: "Method",
  paper: "Paper",
};
const COLORS = {
  condition: "#315fc3",
  intervention: "#13765f",
  test: "#8050a1",
  outcome: "#9a5d15",
  method: "#516378",
  paper: "#315fc3",
};
const num = (n) => Number(n || 0).toLocaleString("en-US");
const THIS_YEAR = new Date().getFullYear();
export function graphLayout(nodes, edges) {
  // Deterministic force layout with rectangular collisions. Labels stay inside
  // their nodes; collisions include label bounds rather than circle radii alone.
  const points = nodes.map((n, i) => ({
    ...n,
    x: 440 + 260 * Math.cos(i * 2.399963),
    y: 240 + 160 * Math.sin(i * 2.399963),
  }));
  const index = new Map(points.map((p) => [p.id, p]));
  for (let step = 0; step < 180; step++) {
    for (const p of points) {
      p.dx = (440 - p.x) * 0.008;
      p.dy = (240 - p.y) * 0.008;
    }
    for (const e of edges) {
      const a = index.get(e.source),
        b = index.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x,
        dy = b.y - a.y,
        d = Math.max(1, Math.hypot(dx, dy)),
        f = (d - 210) * 0.002;
      a.dx += dx * f;
      a.dy += dy * f;
      b.dx -= dx * f;
      b.dy -= dy * f;
    }
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i],
          b = points[j],
          dx = b.x - a.x || 0.1,
          dy = b.y - a.y || 0.1;
        const ox = 184 - Math.abs(dx),
          oy = 100 - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox < oy * 1.8) {
            const v = Math.sign(dx) * ox * 0.3;
            a.dx -= v;
            b.dx += v;
          } else {
            const v = Math.sign(dy) * oy * 0.3;
            a.dy -= v;
            b.dy += v;
          }
        }
      }
    for (const p of points) {
      p.x = Math.max(92, Math.min(788, p.x + p.dx));
      p.y = Math.max(60, Math.min(420, p.y + p.dy));
    }
  }
  if (points.length > 8) {
    const cells = Array.from({ length: 16 }, (_, i) => ({
      x: 128 + (i % 4) * 208,
      y: 65 + Math.floor(i / 4) * 110,
    }));
    for (const point of points) {
      cells.sort(
        (a, b) => Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y),
      );
      Object.assign(point, cells.shift());
    }
  }
  return points;
}
function labelLines(text) {
  const words = text.split(/\s+/),
    lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).length > 22 && line) {
      lines.push(line);
      line = w;
    } else line += (line ? " " : "") + w;
  }
  if (line) lines.push(line);
  return lines
    .slice(0, 2)
    .map((s, i) =>
      s.length > 23 ? s.slice(0, 21) + "…" : i === 1 && lines.length > 2 ? s.slice(0, 20) + "…" : s,
    );
}

function Graph({ data, selected, select }) {
  const [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [list, setList] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width:680px)").matches);
  useEffect(() => {
    const m = window.matchMedia("(max-width:680px)");
    const change = () => setMobile(m.matches);
    m.addEventListener("change", change);
    return () => m.removeEventListener("change", change);
  }, []);
  const drag = useRef(null),
    svg = useRef(null);
  const limit = mobile ? 6 : 16,
    w = mobile ? 380 : 880,
    h = mobile ? 490 : 480;
  const nodes = data.nodes.slice(0, limit),
    edges = data.edges;
  const points = useMemo(
    () =>
      mobile
        ? nodes.map((n, i) => ({ ...n, x: 96 + (i % 2) * 188, y: 76 + Math.floor(i / 2) * 154 }))
        : graphLayout(nodes, edges),
    [data, mobile],
  );
  const byId = new Map(points.map((p) => [p.id, p]));
  const neighbors = new Set(
    edges.flatMap((e) => (e.source === selected ? [e.target] : e.target === selected ? [e.source] : [])),
  );
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [data.relationship]);
  return (
    <div className="atlas-graph-wrap">
      <div className="atlas-graph-toolbar">
        <span>
          <Network size={16} />
          {data.relationship === "citations" ? "Citation network" : "Concept network"}
        </span>
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
            disabled={zoom <= 1}
            onClick={() => setZoom((z) => Math.max(1, z - 0.25))}
          >
            <Minus size={17} />
          </button>
          <button
            aria-label="Zoom in"
            disabled={zoom >= 2.5}
            onClick={() => setZoom((z) => Math.min(2.5, z + 0.25))}
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
            <RotateCcw size={16} />
          </button>
        </div>
      </div>
      {list ? (
        <ul className="atlas-node-list">
          {data.nodes.map((n) => (
            <li key={n.id}>
              <button aria-pressed={selected === n.id} onClick={() => select(n.id)}>
                <i style={{ background: COLORS[n.kind] }} />
                <span>{n.label}</span>
                <small>
                  {data.relationship === "citations" ? n.year : `${num(n.document_count)} papers`}
                </small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="atlas-graph-scroll">
          <svg
            ref={svg}
            viewBox={`0 0 ${w} ${h}`}
            className="atlas-graph"
            role="group"
            aria-label="Concept map from full texts"
            onPointerDown={(e) => {
              if (e.target.closest("[role=button]")) return;
              drag.current = { x: e.clientX, y: e.clientY, pan };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drag.current) return;
              const factor = w / svg.current.getBoundingClientRect().width;
              setPan({
                x: Math.max(-350, Math.min(350, drag.current.pan.x + (e.clientX - drag.current.x) * factor)),
                y: Math.max(-250, Math.min(250, drag.current.pan.y + (e.clientY - drag.current.y) * factor)),
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
              <pattern id="atlas-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" fill="#dde5ee" />
              </pattern>
              <marker
                id="atlas-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#8c9caf" />
              </marker>
            </defs>
            <rect width={w} height={h} fill="url(#atlas-grid)" />
            <g
              transform={`translate(${w / 2 + pan.x} ${h / 2 + pan.y}) scale(${zoom}) translate(${-w / 2} ${-h / 2})`}
            >
              {edges.map((e) => {
                const a = byId.get(e.source),
                  b = byId.get(e.target);
                if (!a || !b) return null;
                const active = e.source === selected || e.target === selected;
                const dx = b.x - a.x,
                  dy = b.y - a.y,
                  t = Math.min(80 / Math.max(1, Math.abs(dx)), 36 / Math.max(1, Math.abs(dy)));
                return (
                  <line
                    key={e.source + e.target}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x - dx * t}
                    y2={b.y - dy * t}
                    stroke={active ? "#517fb3" : "#b5c3d2"}
                    strokeWidth={active ? 2.4 : 1.3}
                    opacity={selected && !active ? 0.25 : 0.75}
                    markerEnd={data.relationship === "citations" ? "url(#atlas-arrow)" : undefined}
                  />
                );
              })}
              {points.map((n) => {
                const active = n.id === selected,
                  lines = labelLines(n.label);
                return (
                  <g
                    key={n.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${n.label}, ${n.document_count} papers`}
                    aria-pressed={active}
                    onClick={() => select(n.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        select(n.id);
                      }
                    }}
                    transform={`translate(${n.x - 80} ${n.y - 36})`}
                    className="atlas-node"
                    opacity={selected && !active && !neighbors.has(n.id) ? 0.65 : 1}
                  >
                    <title>
                      {n.label} · {num(n.document_count)} papers
                    </title>
                    <rect
                      width="160"
                      height="72"
                      rx="12"
                      fill={active ? "#edf5ff" : "#fff"}
                      stroke={active ? "#315fc3" : "#ced9e5"}
                      strokeWidth={active ? 2 : 1}
                    />
                    <circle cx="14" cy="17" r="4" fill={COLORS[n.kind]} />
                    <text x="25" y="21" className="atlas-node-type">
                      {n.kind === "paper" ? n.year : TYPES[n.kind]}
                    </text>
                    {lines.map((line, i) => (
                      <text key={i} x="12" y={40 + i * 15} className="atlas-node-label">
                        {line}
                      </text>
                    ))}
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
      )}
      <div className="atlas-graph-legend">
        {Object.entries(TYPES)
          .filter(([k]) => nodes.some((n) => n.kind === k))
          .map(([k, v]) => (
            <span key={k}>
              <i style={{ background: COLORS[k] }} />
              {v}
            </span>
          ))}
      </div>
      <p className="atlas-graph-note">
        {data.relationship === "citations"
          ? "Arrows follow identified cited references between the displayed papers. Missing links may reflect incomplete metadata."
          : "Lines represent shared papers, not evidence strength or treatment effects."}{" "}
        Showing {Math.min(list ? 24 : limit, data.nodes.length)} nodes.{" "}
        {data.nodes.length > limit && !list && (
          <button onClick={() => setList(true)}>View all {data.nodes.length}</button>
        )}
      </p>
    </div>
  );
}

function ConceptPreview({ id }) {
  const r = useResource(() => rpc("knowledge_page", { p_id: id, p_page: 0 }), [id]);
  return (
    <Resource resource={r} {...ENGLISH_RESOURCE}>
      {r.data && (
        <>
          <span className="atlas-eyebrow">{TYPES[r.data.concept.kind]}</span>
          <h2>{r.data.concept.label}</h2>
          <p className="atlas-footnote">
            {num(r.data.concept.document_count)} connected papers across the indexed corpus
          </p>
          <KnowledgeNarrative wiki={r.data.wiki} />
          <Link className="atlas-text-link" to={`/knowledge/${id}`}>
            Open full knowledge page <ArrowUpRight size={16} />
          </Link>
          {!!r.data.neighbors.length && (
            <div className="atlas-neighbors">
              <h3>Connected concepts</h3>
              {r.data.neighbors.slice(0, 5).map((n) => (
                <Link key={n.id} to={`/insights?concept=${n.id}`}>
                  <span>{n.label}</span>
                  <small>{num(n.shared_papers)} shared papers</small>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </Resource>
  );
}

function Timeline({ years, choose }) {
  const maximum = Math.max(1, ...years.map((y) => Number(y.papers)));
  return (
    <section className="atlas-timeline" aria-label="Indexed papers by publication year">
      <div>
        <h2>Research over time</h2>
        <p>Indexed papers by catalog publication year</p>
      </div>
      {!years.length ? (
        <p className="atlas-empty">No papers match this period.</p>
      ) : (
        <div className="atlas-bars">
          {years.map((y) => (
            <button
              key={y.year}
              aria-label={`${y.year}: ${num(y.papers)} papers; ${num(y.structured)} structured`}
              onClick={() => choose(y.year)}
            >
              <span className="atlas-bar-count">{num(y.papers)}</span>
              <span className="atlas-bar-track">
                <i style={{ height: `${Math.max(3, (Number(y.papers) / maximum) * 100)}%` }} />
              </span>
              <span>{y.year}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export default function ResearchAtlas() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get("concept") || null,
    query = params.get("q") || "",
    journal = params.get("journal") || "",
    design = params.get("design") || "";
  const from = Math.max(2000, Math.min(2100, Number(params.get("from")) || 2000)),
    to = Math.max(from, Math.min(2100, Number(params.get("to")) || THIS_YEAR));
  const page = Math.max(0, Math.min(10000, Number(params.get("page")) || 0)),
    relation = params.get("relation") === "citations" ? "citations" : "concepts";
  const [draft, setDraft] = useState(query),
    [filters, setFilters] = useState(false),
    [paperSelected, setPaperSelected] = useState(null);
  useEffect(() => setDraft(query), [query]);
  const update = (fields) => {
    const next = new URLSearchParams(params);
    next.delete("page");
    next.delete("view");
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, String(v));
    }
    setParams(next);
  };
  const r = useResource(
    () =>
      rpc("knowledge_atlas", {
        p_query: query.slice(0, 200),
        p_from: from,
        p_to: to,
        p_journal: journal,
        p_design: design,
        p_concept: selected,
        p_page: page,
        p_relation: relation,
      }),
    [user.id, query, from, to, journal, design, selected, page, relation],
  );
  const d = r.data;
  const selectedNode = d?.nodes.find((n) => n.id === (relation === "citations" ? paperSelected : selected));
  const activeFilters = !!(query || journal || design || from !== 2000 || to !== THIS_YEAR || selected);
  return (
    <div className="atlas-page h-full overflow-y-auto" lang="en">
      <div className="atlas-container">
        <header className="atlas-header">
          <div>
            <span className="atlas-eyebrow">KNOWLEDGE & CONNECTIONS</span>
            <h1>Research atlas</h1>
            <p>Concepts, papers and research over time.</p>
          </div>
          <nav className="atlas-tabs" aria-label="Insights views">
            <Link aria-current="page" to="/insights">
              <Network size={17} />
              Research atlas
            </Link>
            <Link to="/insights?view=activity">My activity</Link>
          </nav>
        </header>
        <div className="atlas-controls">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              update({ q: draft.trim(), concept: null });
            }}
          >
            <label className="sr-only" htmlFor="atlas-search">
              Search concepts, papers or identifiers
            </label>
            <Search size={19} />
            <input
              id="atlas-search"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Search a concept, paper, PMID or DOI"
              maxLength={200}
            />
            <button type="submit">Search</button>
          </form>
          <button
            className="atlas-filter-button"
            aria-expanded={filters}
            onClick={() => setFilters(!filters)}
          >
            <SlidersHorizontal size={17} />
            Filters{(journal || design || from !== 2000 || to !== THIS_YEAR) && <i />}
          </button>
          <Link to="/knowledge" className="atlas-directory-link">
            Concept directory <ArrowUpRight size={16} />
          </Link>
        </div>
        {filters && (
          <div className="atlas-filters">
            <label>
              From year
              <select
                value={from}
                onChange={(e) => update({ from: e.target.value, to: Math.max(Number(e.target.value), to) })}
              >
                {Array.from({ length: THIS_YEAR - 1999 }, (_, i) => 2000 + i).map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
            </label>
            <label>
              To year
              <select
                value={to}
                onChange={(e) => update({ to: e.target.value, from: Math.min(Number(e.target.value), from) })}
              >
                {Array.from({ length: THIS_YEAR - 1999 }, (_, i) => 2000 + i).map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
            </label>
            <label>
              Journal
              <select value={journal} onChange={(e) => update({ journal: e.target.value })}>
                <option value="">All indexed journals</option>
                {(d?.journals || []).map((j) => (
                  <option key={j.label} value={j.label}>
                    {j.label} ({num(j.papers)})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Study type
              <select value={design} onChange={(e) => update({ design: e.target.value })}>
                <option value="">All study types</option>
                {(d?.designs || []).map((t) => (
                  <option key={t.label} value={t.label}>
                    {t.label.replaceAll("_", " ")} ({num(t.papers)})
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {activeFilters && (
          <div className="atlas-filter-summary">
            <span>
              {from}–{to}
              {journal ? ` · ${journal}` : ""}
              {design ? ` · ${design.replaceAll("_", " ")}` : ""}
              {query ? ` · “${query}”` : ""}
              {selected ? " · Selected concept" : ""}
            </span>
            <button onClick={() => setParams({})}>
              <X size={14} />
              Clear filters
            </button>
          </div>
        )}
        <Resource resource={r} {...ENGLISH_RESOURCE}>
          {d && (
            <>
              <div className="atlas-status">
                <span>
                  <b>{num(d.matched_documents)}</b> matching papers
                </span>
                <span>
                  <b>{num(d.indexed_documents)}</b> full texts indexed across the corpus
                </span>
                <span>
                  <b>{num(d.structured_documents)}</b> with structured records in this selection
                </span>
                <Link to="/discover">
                  Search all literature <ArrowUpRight size={14} />
                </Link>
              </div>
              <div className="atlas-workbench">
                <section className="atlas-network-panel" aria-label="Research network">
                  <div className="atlas-network-heading">
                    <div>
                      <h2>Research connections</h2>
                      <p>Select a node to read its knowledge and connected papers.</p>
                    </div>
                    <div className="atlas-segment" aria-label="Network relationship">
                      <button
                        aria-pressed={relation === "concepts"}
                        onClick={() => update({ relation: null })}
                      >
                        Concepts
                      </button>
                      <button
                        aria-pressed={relation === "citations"}
                        onClick={() => update({ relation: "citations" })}
                      >
                        Citations
                      </button>
                    </div>
                  </div>
                  {d.nodes.length ? (
                    <Graph
                      data={d}
                      selected={relation === "citations" ? paperSelected : selected}
                      select={(id) =>
                        relation === "citations" ? setPaperSelected(id) : update({ concept: id })
                      }
                    />
                  ) : (
                    <div className="atlas-no-network">
                      <Network size={36} />
                      <h3>
                        {activeFilters
                          ? "No indexed papers match these filters."
                          : "The corpus is being indexed."}
                      </h3>
                      <p>
                        {activeFilters
                          ? "Broaden your search or clear the filters."
                          : "Concepts and connections will appear as full texts are processed."}
                      </p>
                      {activeFilters && <button onClick={() => setParams({})}>Clear filters</button>}
                    </div>
                  )}
                </section>
                <aside className="atlas-detail" aria-label="Selected research" aria-live="polite">
                  {relation === "concepts" && selected ? (
                    <ConceptPreview key={selected} id={selected} />
                  ) : relation === "citations" && paperSelected ? (
                    <>
                      <span className="atlas-eyebrow">SELECTED PAPER</span>
                      <h2>{selectedNode?.label || `PMID ${paperSelected}`}</h2>
                      <p>Arrows point from a citing paper to its referenced paper.</p>
                      <Link className="atlas-text-link" to={`/papers/${paperSelected}`}>
                        Read paper <ArrowUpRight size={16} />
                      </Link>
                    </>
                  ) : (
                    <>
                      <span className="atlas-eyebrow">START EXPLORING</span>
                      <h2>A connected view of the literature.</h2>
                      <p>Select a labeled node. Its knowledge page opens here, alongside the network.</p>
                      <div className="atlas-topics">
                        {d.nodes.slice(0, 5).map((n) => (
                          <button
                            key={n.id}
                            onClick={() =>
                              relation === "citations" ? setPaperSelected(n.id) : update({ concept: n.id })
                            }
                          >
                            <i style={{ background: COLORS[n.kind] }} />
                            <span>{n.label}</span>
                            <ChevronRight size={16} />
                          </button>
                        ))}
                      </div>
                      <p className="atlas-footnote">
                        This map covers indexed full texts, not every catalog record. Counts describe papers,
                        not independent studies.
                      </p>
                    </>
                  )}
                </aside>
              </div>
              <Timeline years={d.years} choose={(year) => update({ from: year, to: year })} />
              <section className="atlas-paper-section">
                <div className="atlas-section-heading">
                  <div>
                    <span className="atlas-eyebrow">CONNECTED LITERATURE</span>
                    <h2>{selected ? "Papers behind this concept" : "Papers in this view"}</h2>
                  </div>
                  <span>{num(d.matched_documents)} papers</span>
                </div>
                <p className="atlas-footnote">
                  Newest first · Study types use catalog classifications. Open a research record for
                  source-bound study context, numerical results and date precision.
                </p>
                {!d.papers.length && <p className="atlas-empty">No indexed papers match this selection.</p>}
                {d.papers.slice(0, 20).map((p) => (
                  <ScientificPaper key={p.pmid} paper={p} />
                ))}
                <nav className="atlas-pagination" aria-label="Paper pages">
                  <button disabled={!page} onClick={() => update({ page: page - 1 })}>
                    <ChevronLeft size={16} />
                    Previous
                  </button>
                  <span>Page {page + 1}</span>
                  <button disabled={d.papers.length <= 20} onClick={() => update({ page: page + 1 })}>
                    Next
                    <ChevronRight size={16} />
                  </button>
                </nav>
              </section>
            </>
          )}
        </Resource>
      </div>
    </div>
  );
}
