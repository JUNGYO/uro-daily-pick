import { useEffect, useState } from "react";
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
import { Resource } from "../components/ReaderUI";
import { useRefreshingResource as useResource } from "../lib/useRefreshingResource";
import KnowledgeRefresh from "../components/KnowledgeRefresh";
import { ENGLISH_RESOURCE, KnowledgeNarrative, ScientificPaper } from "../components/KnowledgeEvidence";
import "../knowledge.css";
import ResearchNetwork from "../components/ResearchNetwork";
import { CATEGORY_LABELS, categoryColor } from "../lib/researchNetwork";

const num = (n) => Number(n || 0).toLocaleString("en-US");
const THIS_YEAR = new Date().getFullYear();
function ConceptPreview({ data }) {
  const item = data.selection,
    peer = data.selection_peer;
  if (!item) return <p>This concept has no papers under the current filters.</p>;
  if (peer) {
    const shared = Number(data.selected_documents),
      union = Number(item.document_count) + Number(peer.document_count) - shared;
    return (
      <>
        <span className="atlas-eyebrow">CONCEPT CO-OCCURRENCE</span>
        <h2>
          {item.label} × {peer.label}
        </h2>
        <dl className="network-pair-stats">
          <div>
            <dt>Shared papers</dt>
            <dd>{num(shared)}</dd>
          </div>
          <div>
            <dt>Jaccard overlap</dt>
            <dd>{union ? (shared / union).toFixed(3) : "0.000"}</dd>
          </div>
        </dl>
        <p>
          {num(item.document_count)} papers mention {item.label}; {num(peer.document_count)} mention{" "}
          {peer.label}.
        </p>
        <p className="atlas-footnote">
          {shared} ÷ ({item.document_count} + {peer.document_count} − {shared}). The paper list below contains
          both concepts. This measures co-occurrence, not an association or treatment effect.
        </p>
      </>
    );
  }
  return (
    <>
      <span className="atlas-eyebrow">{CATEGORY_LABELS[item.kind] || "Unresolved term"}</span>
      <h2>{item.label}</h2>
      <p>{num(item.document_count)} distinct papers in the filtered corpus</p>
      <p className="network-authority">
        {item.resolution === "exact"
          ? `MeSH ${item.vocabulary_year} · ${item.concept_ui} · Exact concept match`
          : "No unambiguous MeSH match. The extracted label is retained without assigning a scientific category."}
      </p>
      {item.source_labels?.length > 1 && (
        <details>
          <summary>Source labels ({item.source_labels.length})</summary>
          <p>{item.source_labels.join(" · ")}</p>
        </details>
      )}
      {!!data.notes?.length ? (
        data.notes.map((n) => (
          <section className="network-note" key={n.concept_id}>
            {data.notes.length > 1 && <h3>{n.label}</h3>}
            <KnowledgeNarrative wiki={n.wiki} />
            <Link className="atlas-text-link" to={`/knowledge/${n.concept_id}`}>
              Open full knowledge page <ArrowUpRight size={16} />
            </Link>
          </section>
        ))
      ) : (
        <p className="atlas-footnote">
          No current narrative is available. Explore the connected papers below.
        </p>
      )}
    </>
  );
}

function Timeline({ years, choose }) {
  const maximum = Math.max(1, ...years.map((y) => Number(y.papers)));
  return (
    <section className="atlas-timeline" aria-label="Indexed papers by publication year">
      <div>
        <h2>Indexed papers over time</h2>
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
    [filters, setFilters] = useState(false);
  const peer = params.get("with") || null;
  const minimum = [1, 2, 3, 5, 10].includes(Number(params.get("min"))) ? Number(params.get("min")) : 1;
  const limit = [30, 60, 100].includes(Number(params.get("limit"))) ? Number(params.get("limit")) : 60;
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
      rpc("knowledge_network", {
        p_filters: {
          q: query.slice(0, 200),
          from,
          to,
          journal,
          design,
          focus: selected,
          peer,
          page,
          relation,
          min_shared: minimum,
          limit,
        },
      }),
    [user.id, query, from, to, journal, design, selected, peer, page, relation, minimum, limit],
  );
  const d = r.data;
  const selectedNode = d?.nodes.find((n) => n.id === selected);
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
              update({ q: draft.trim(), concept: null, with: null });
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
            Knowledge pages <ArrowUpRight size={16} />
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
              <KnowledgeRefresh resource={r} />
              <div className="atlas-workbench">
                <section className="atlas-network-panel" aria-label="Research network">
                  <div className="atlas-network-heading">
                    <div>
                      <h2>Research connections</h2>
                      <p>Select a concept or connection to inspect its papers.</p>
                    </div>
                    <div className="atlas-segment" aria-label="Network relationship">
                      <button
                        aria-pressed={relation === "concepts"}
                        onClick={() => update({ relation: null, concept: null, with: null })}
                      >
                        Concepts
                      </button>
                      <button
                        aria-pressed={relation === "citations"}
                        onClick={() => update({ relation: "citations", concept: null, with: null })}
                      >
                        Citations
                      </button>
                    </div>
                  </div>
                  {d.nodes.length ? (
                    <ResearchNetwork
                      key={relation}
                      data={d}
                      selected={d.focus || selected}
                      peer={d.peer || peer}
                      select={(id) => update({ concept: id, with: null })}
                      selectEdge={(a, b) => update({ concept: a, with: b })}
                      minimum={minimum}
                      setMinimum={(min) => update({ min })}
                      limit={limit}
                      setLimit={(value) => update({ limit: value })}
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
                    <ConceptPreview data={d} />
                  ) : relation === "citations" && selected ? (
                    <>
                      <span className="atlas-eyebrow">SELECTED PAPER</span>
                      <h2>{selectedNode?.label || `PMID ${selected}`}</h2>
                      <p>
                        Arrows point from a citing paper to its referenced paper.{" "}
                        {peer
                          ? "The two selected papers are listed below."
                          : selectedNode?.metadata_available
                            ? "Reference metadata retrieved; the list may be incomplete."
                            : "Reference metadata has not been retrieved."}
                      </p>
                      <Link className="atlas-text-link" to={`/papers/${selected}`}>
                        Read paper <ArrowUpRight size={16} />
                      </Link>
                    </>
                  ) : (
                    <>
                      <span className="atlas-eyebrow">START EXPLORING</span>
                      <h2>A connected view of the literature.</h2>
                      <p>
                        Select a node for its knowledge and papers. Select a line to inspect the shared papers
                        and overlap.
                      </p>
                      <div className="atlas-topics">
                        {d.nodes.slice(0, 5).map((n) => (
                          <button key={n.id} onClick={() => update({ concept: n.id, with: null })}>
                            <i style={{ background: categoryColor(n.kind) }} />
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
                    <h2>
                      {peer
                        ? "Papers behind this connection"
                        : selected
                          ? "Papers behind this selection"
                          : "Papers in this view"}
                    </h2>
                  </div>
                  <span>{num(d.selected_documents)} papers</span>
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
