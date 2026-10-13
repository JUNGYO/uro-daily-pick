import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Network, ArrowUpRight, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { rpc } from "../lib/workspace";
import { useRefreshingResource } from "../lib/useRefreshingResource";
import { Resource } from "../components/ReaderUI";
import { ENGLISH_RESOURCE } from "../components/KnowledgeEvidence";
import KnowledgeRefresh from "../components/KnowledgeRefresh";
import {
  landscapePeriods,
  periodCount,
  sortedFlows,
  subjectLabel,
  yearLabel,
} from "../lib/literatureLandscape";
import "../knowledge.css";

const num = (n) => Number(n || 0).toLocaleString("en-US");
const numberParam = (params, name) =>
  params.has(name) && params.get(name) !== "" ? Number(params.get(name)) : null;

function CitationPaper({ pmid, doi, title, inCatalog }) {
  const label = title || (pmid ? `PMID ${pmid}` : `DOI ${doi}`);
  return inCatalog && pmid ? (
    <Link to={`/papers/${pmid}`}>{label}</Link>
  ) : (
    <a
      href={pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : `https://doi.org/${encodeURIComponent(doi)}`}
      target="_blank"
      rel="noreferrer"
    >
      {label} <ArrowUpRight size={13} />
    </a>
  );
}

export default function LiteratureLandscape() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const mode = params.get("landscape") === "citations" ? "citations" : "topics";
  const subject = params.get("subject") || "",
    query = params.get("subject_q") || "";
  const [draft, setDraft] = useState(query),
    [width, setWidth] = useState(5),
    [flowPage, setFlowPage] = useState(0);
  const overviewRef = useRef(null),
    detailRef = useRef(null),
    pendingSection = useRef(null);
  const reveal = (section) => {
    const target = section === "overview" ? overviewRef.current : detailRef.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "start" });
  };
  const filters = {
    mode,
    subject,
    subject_q: query,
    subject_page: numberParam(params, "subject_page") || 0,
    from: numberParam(params, "from"),
    to: numberParam(params, "to"),
    journal: params.get("journal") || "",
    after: numberParam(params, "after"),
    paper_year: numberParam(params, "paper_year"),
    citing_year: numberParam(params, "citing_year"),
    target_year: numberParam(params, "target_year"),
    edge_after: params.get("edge_after") || "",
  };
  const signature = JSON.stringify(filters);
  const r = useRefreshingResource(
    () => rpc("knowledge_landscape", { p_filters: filters }),
    [user.id, signature],
    300000,
  );
  const d = r.data,
    c = d?.coverage;
  useEffect(() => {
    if (d?.ready && pendingSection.current) {
      reveal(pendingSection.current);
      pendingSection.current = null;
    }
  }, [d]);
  useEffect(() => setDraft(query), [query]);
  useEffect(() => setFlowPage(0), [subject, filters.from, filters.to, filters.journal]);
  const update = (fields, reset = true) => {
    const section =
      "subject_page" in fields || "subject_q" in fields || ("landscape" in fields && !fields.landscape)
        ? "overview"
        : "detail";
    if (Object.entries(fields).every(([key, value]) => String(value ?? "") === (params.get(key) || ""))) {
      reveal(section);
      return;
    }
    pendingSection.current = section;
    const next = new URLSearchParams(params);
    // Retain fixture/query context, but never reuse old graph node budgets.
    ["concept", "with", "limit", "page", "unlinkedPage", "q", "design", "min"].forEach((key) =>
      next.delete(key),
    );
    next.set("relation", "citations");
    if (reset) ["after", "edge_after"].forEach((key) => next.delete(key));
    Object.entries(fields).forEach(([key, value]) =>
      value == null || value === "" ? next.delete(key) : next.set(key, String(value)),
    );
    setParams(next);
  };
  const periods = landscapePeriods(d?.years || [], width);
  const cells = (d?.subjects || []).flatMap((t) => periods.map((p) => periodCount(t.years, p)));
  const max = Math.max(1, ...cells);
  const flows = sortedFlows(d?.flows || []);
  const clearSelection = () =>
    update({ subject: null, paper_year: null, citing_year: null, target_year: null });
  return (
    <div className="atlas-page h-full overflow-y-auto" lang="en">
      <div className="atlas-container landscape">
        <header className="atlas-header">
          <div>
            <span className="atlas-eyebrow">CITATION MAP</span>
            <h1>Citation map</h1>
            <p>Explore subjects over time, then follow the papers and their identified references.</p>
          </div>
          <nav className="atlas-tabs" aria-label="Insights views">
            <Link aria-current="page" to="/insights">
              <Network size={17} /> Research atlas
            </Link>
            <Link to="/insights?view=activity">My activity</Link>
          </nav>
        </header>
        <nav className="landscape-views" aria-label="Citation views">
          <button aria-pressed={mode === "topics"} onClick={() => update({ landscape: null })}>
            Topics over time
          </button>
          <button aria-pressed={mode === "citations"} onClick={() => update({ landscape: "citations" })}>
            Citation flows
          </button>
          <Link to="/insights">
            Concepts <ArrowUpRight size={14} />
          </Link>
        </nav>
        <form
          className="landscape-filters"
          onSubmit={(e) => {
            e.preventDefault();
            update({ subject_q: draft.trim(), subject_page: null });
          }}
        >
          <label>
            Find a MeSH subject
            <input
              value={draft}
              maxLength={200}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. prostatic neoplasms"
            />
          </label>
          <button type="submit">Find subject</button>
          <label>
            From year
            <input
              type="number"
              min="1000"
              max="3000"
              aria-label="From year"
              placeholder="All"
              value={filters.from ?? ""}
              onChange={(e) => update({ from: e.target.value, subject_page: null, paper_year: null })}
            />
          </label>
          <label>
            To year
            <input
              type="number"
              min="1000"
              max="3000"
              aria-label="To year"
              placeholder="All"
              value={filters.to ?? ""}
              onChange={(e) => update({ to: e.target.value, subject_page: null, paper_year: null })}
            />
          </label>
          <label>
            Journal
            <select
              value={filters.journal}
              onChange={(e) => update({ journal: e.target.value, subject_page: null })}
            >
              <option value="">All catalog journals</option>
              {(d?.journals || []).map((j) => (
                <option key={j.label}>{j.label}</option>
              ))}
            </select>
          </label>
          {(filters.from || filters.to || filters.journal || query) && (
            <button
              type="button"
              onClick={() =>
                update({
                  from: null,
                  to: null,
                  journal: null,
                  subject_q: null,
                  subject_page: null,
                  paper_year: null,
                })
              }
            >
              Reset filters
            </button>
          )}
        </form>
        <Resource resource={r} {...ENGLISH_RESOURCE}>
          {d && !d.ready && (
            <div className="landscape-empty" role="status">
              <h2>Preparing the catalog overview</h2>
              <p>
                Metadata initialization is still in progress. Complete-catalog counts will appear when it
                finishes.
              </p>
            </div>
          )}
          {d?.ready && (
            <>
              <div className="landscape-coverage" aria-label="Catalog coverage">
                <div>
                  <b>{num(c.catalog_papers)}</b>
                  <span>current catalog papers</span>
                </div>
                <div>
                  <b>{num(c.matching_papers)}</b>
                  <span>within year / journal filters</span>
                </div>
                <div>
                  <b>{num(c.subject_papers)}</b>
                  <span>with subject metadata in these filters</span>
                </div>
                <div>
                  <b>
                    {num(c.indexed_papers)} / {num(c.selected_papers)}
                  </b>
                  <span>
                    originals indexed / papers{subject ? " in selected subject" : " in these filters"}
                  </span>
                </div>
              </div>
              <KnowledgeRefresh resource={r} />
              {mode === "topics" && (
                <section
                  ref={overviewRef}
                  tabIndex={-1}
                  className="landscape-overview"
                  aria-labelledby="landscape-title"
                >
                  <div className="landscape-section-heading">
                    <div>
                      <span className="atlas-eyebrow">ALL MATCHING PAPERS COUNTED</span>
                      <h2 id="landscape-title">Subjects across publication years</h2>
                    </div>
                    <label>
                      Time scale
                      <select value={width} onChange={(e) => setWidth(Number(e.target.value))}>
                        <option value={5}>Five-year periods</option>
                        <option value={1}>Individual years</option>
                      </select>
                    </label>
                  </div>
                  <p>
                    Each row counts every matching paper assigned that MeSH subject. Select a subject to
                    inspect its papers or citation flows. A paper can belong to several rows. Scroll the table
                    horizontally to compare all periods.
                  </p>
                  <div
                    className="landscape-table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Subject and publication year table"
                  >
                    <table className="landscape-heatmap">
                      <caption>
                        Publication counts by subject. Darker cells mean more papers; numbers are exact
                        counts.
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Subject</th>
                          {periods.map((p) => (
                            <th scope="col" key={p.key}>
                              {p.label}
                            </th>
                          ))}
                          <th scope="col">All years</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="landscape-total">
                          <th scope="row">
                            <button onClick={clearSelection}>All matching papers</button>
                          </th>
                          {periods.map((p) => (
                            <td key={p.key}>{num(periodCount(d.years, p))}</td>
                          ))}
                          <td>{num(c.matching_papers)}</td>
                        </tr>
                        {d.subjects.map((t) => (
                          <tr key={t.topic} aria-selected={subject === t.topic}>
                            <th scope="row">
                              <button
                                aria-pressed={subject === t.topic}
                                onClick={() =>
                                  update({
                                    subject: t.topic,
                                    paper_year: null,
                                    citing_year: null,
                                    target_year: null,
                                  })
                                }
                              >
                                {subjectLabel(t.topic)}
                              </button>
                            </th>
                            {periods.map((p) => {
                              const count = periodCount(t.years, p);
                              return (
                                <td
                                  key={p.key}
                                  style={{
                                    backgroundColor: `rgba(14,116,144,${count ? 0.06 + 0.36 * Math.sqrt(count / max) : 0})`,
                                  }}
                                >
                                  {num(count)}
                                </td>
                              );
                            })}
                            <td>{num(t.papers)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!d.subjects.length && <p className="landscape-empty">No subjects match this search.</p>}
                  <div className="landscape-pagination">
                    <span>
                      Subjects {d.subject_count ? d.subject_page * 20 + 1 : 0}–
                      {Math.min((d.subject_page + 1) * 20, d.subject_count)} of {num(d.subject_count)} ·
                      ordered by paper count
                    </span>
                    <button
                      disabled={!d.subject_page}
                      onClick={() => update({ subject_page: d.subject_page - 1 })}
                    >
                      Previous subjects
                    </button>
                    <button
                      disabled={(d.subject_page + 1) * 20 >= d.subject_count}
                      onClick={() => update({ subject_page: d.subject_page + 1 })}
                    >
                      More subjects
                    </button>
                  </div>
                  <p className="landscape-note">
                    Subject pagination changes visible rows, never the papers included in a count.{" "}
                    {num(c.matching_papers - c.subject_papers)} papers have no usable subject metadata;{" "}
                    {num(c.unknown_year)} have no publication year.
                  </p>
                </section>
              )}
              {mode === "citations" && (
                <button onClick={() => update({ landscape: null })}>
                  Choose a subject in Topics over time
                </button>
              )}
              <section
                ref={detailRef}
                tabIndex={-1}
                className="landscape-detail"
                aria-label="Selected literature"
              >
                <div className="landscape-section-heading">
                  <div>
                    <span className="atlas-eyebrow">
                      {subject ? "SELECTED SUBJECT" : "ENTIRE FILTERED CATALOG"}
                    </span>
                    <h2>{subject ? subjectLabel(subject) : "All matching literature"}</h2>
                    <p>{num(c.selected_papers)} papers</p>
                  </div>
                  {subject && (
                    <button onClick={clearSelection}>
                      <X size={14} /> Clear subject
                    </button>
                  )}
                </div>
                {mode === "topics" ? (
                  <>
                    <label className="landscape-year-select">
                      Publication year
                      <select
                        value={filters.paper_year ?? ""}
                        onChange={(e) => update({ paper_year: e.target.value })}
                      >
                        <option value="">All years</option>
                        {d.years.map((y) => (
                          <option key={y.year ?? 0} value={y.year ?? 0}>
                            {yearLabel(y.year)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p>{num(d.paper_count)} papers in this selection · newest catalog records first</p>
                    <ol className="landscape-paper-list">
                      {d.papers.map((p) => (
                        <li key={p.id}>
                          <Link to={`/papers/${p.pmid}`}>{p.title}</Link>
                          <span>
                            {p.journal || "Journal unknown"} · {p.pub_date || "Date unknown"} · PMID {p.pmid}
                          </span>
                        </li>
                      ))}
                    </ol>
                    {!d.papers.length && <p>No papers match this selection.</p>}
                    <div className="landscape-pagination">
                      {filters.after && <button onClick={() => update({ after: null })}>First papers</button>}
                      <button disabled={!d.next_after} onClick={() => update({ after: d.next_after }, false)}>
                        More papers
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h3>Identified citation flows</h3>
                    <p className="landscape-citation-coverage">
                      Reference metadata is available for{" "}
                      <b>
                        {num(c.reference_metadata_papers)} of {num(c.selected_papers)}
                      </b>{" "}
                      selected papers; {num(c.papers_with_reference_ids)} contain reference identifiers. These
                      yield {num(c.citation_links)} distinct directed links. This is a partial citation index.
                    </p>
                    <div
                      className="landscape-table-scroll"
                      tabIndex={0}
                      role="region"
                      aria-label="Citation flows by publication year"
                    >
                      <table className="landscape-flow-table">
                        <caption>
                          Citing publication year → referenced publication year. Counts include every
                          identified link in this selection.
                        </caption>
                        <thead>
                          <tr>
                            <th>Citing year</th>
                            <th>Referenced year</th>
                            <th>Links</th>
                            <th>Citing papers</th>
                            <th>Evidence</th>
                          </tr>
                        </thead>
                        <tbody>
                          {flows.slice(flowPage * 20, (flowPage + 1) * 20).map((flow) => (
                            <tr key={`${flow.source_year}:${flow.target_year}`}>
                              <td>{yearLabel(flow.source_year)}</td>
                              <td>{yearLabel(flow.target_year)}</td>
                              <td>
                                <span
                                  className="landscape-flow-bar"
                                  style={{
                                    width: `${Math.max(4, (70 * flow.links) / Math.max(1, ...flows.map((v) => v.links)))}px`,
                                  }}
                                />
                                {num(flow.links)}
                              </td>
                              <td>{num(flow.citing_papers)}</td>
                              <td>
                                <button
                                  aria-label={`Show citations from ${yearLabel(flow.source_year)} to ${yearLabel(flow.target_year)}`}
                                  onClick={() =>
                                    update({
                                      citing_year: flow.source_year ?? 0,
                                      target_year: flow.target_year ?? 0,
                                    })
                                  }
                                >
                                  Show papers
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!flows.length && (
                      <p>
                        No identified reference links are available in this selection. This does not establish
                        an absence of citations.
                      </p>
                    )}
                    <div className="landscape-pagination">
                      <span>
                        {num(flows.length)} year pairs · {num(c.unknown_target_year_links)} links have an
                        unknown referenced year
                      </span>
                      <button disabled={!flowPage} onClick={() => setFlowPage(flowPage - 1)}>
                        Previous flows
                      </button>
                      <button
                        disabled={(flowPage + 1) * 20 >= flows.length}
                        onClick={() => setFlowPage(flowPage + 1)}
                      >
                        More flows
                      </button>
                    </div>
                    <h3>Source papers for these links</h3>
                    <p>
                      {num(d.edge_count)} links
                      {filters.citing_year != null
                        ? ` · ${yearLabel(filters.citing_year)} → ${yearLabel(filters.target_year)}`
                        : " across all years"}
                    </p>
                    {filters.citing_year != null && (
                      <button onClick={() => update({ citing_year: null, target_year: null })}>
                        All citation years
                      </button>
                    )}
                    <ol className="landscape-paper-list landscape-citation-list">
                      {d.citation_papers.map((e) => (
                        <li key={e.edge_key}>
                          <span>Citing paper · {yearLabel(e.source_year)}</span>
                          <CitationPaper pmid={e.source_pmid} title={e.source_title} inCatalog />
                          <span>
                            References ↓ · {yearLabel(e.target_year)}
                            {!e.target_id
                              ? " · outside the catalog; other metadata unassessed"
                              : e.target_status !== "current"
                                ? ` · ${e.target_status}`
                                : ""}
                          </span>
                          <CitationPaper
                            pmid={e.target_pmid}
                            doi={e.target_doi}
                            title={e.target_title}
                            inCatalog={!!e.target_id}
                          />
                        </li>
                      ))}
                    </ol>
                    <div className="landscape-pagination">
                      {filters.edge_after && (
                        <button onClick={() => update({ edge_after: null })}>First links</button>
                      )}
                      <button
                        disabled={!d.next_edge}
                        onClick={() => update({ edge_after: d.next_edge }, false)}
                      >
                        More citation links
                      </button>
                    </div>
                  </>
                )}
              </section>
              <details className="landscape-method">
                <summary>Scope and interpretation</summary>
                <p>
                  This overview uses every current paper in the service catalog, including papers without
                  acquired or indexed originals. Year and journal filters define the counted set. MeSH labels
                  are grouped by exact text after trimming and case normalization; common human, animal, sex
                  and age check tags are omitted. No acronym expansion, inferred topic clusters or clinical
                  relationships are added.
                </p>
                <p>
                  Publication counts describe this catalog, not the entire research field. Multiple subjects
                  per paper, absent MeSH indexing, incomplete recent years and collection coverage affect the
                  pattern. Counts refer to papers, not independent studies. More publications do not establish
                  better evidence or clinical progress.
                </p>
                <p>
                  Citation flows use explicit PMID/DOI identifiers from reference metadata and
                  original-derived records matching the indexed source hash. Repeated identifiers resolving to
                  the same target count once per citing paper. Referenced papers may be outside the selected
                  years, outside the catalog, or retracted; unknown dates remain unknown. A link does not
                  imply agreement, quality or causality.
                </p>
              </details>
            </>
          )}
        </Resource>
      </div>
    </div>
  );
}
