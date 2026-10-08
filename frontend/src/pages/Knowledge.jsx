import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { rpc } from "../lib/workspace";
import { ReaderPage, Resource, useResource } from "../components/ReaderUI";
import "../knowledge.css";

const TYPES = {
  condition: "Condition",
  intervention: "Treatment / procedure",
  test: "Test",
  outcome: "Outcome",
  method: "Method",
};
const COLORS = {
  condition: "#2364aa",
  intervention: "#237b61",
  test: "#8455ae",
  outcome: "#a56412",
  method: "#526475",
};
const number = (n) => Number(n || 0).toLocaleString("en-US");
const date = (s) => (s ? new Date(s).toLocaleDateString("en-US", { timeZone: "Asia/Seoul" }) : "");
const detailUrl = (id) => "/knowledge/" + encodeURIComponent(id);

function Pager({ page, more, change }) {
  return (
    <nav className="knowledge-pager" aria-label="Knowledge pages">
      <button className="btn-secondary" disabled={!page} onClick={() => change(page - 1)}>
        Previous
      </button>
      <span>Page {page + 1}</span>
      <button className="btn-secondary" disabled={!more} onClick={() => change(page + 1)}>
        Next
      </button>
    </nav>
  );
}

export function KnowledgeMap({ focus = null }) {
  const { user } = useAuth();
  const r = useResource(() => rpc("knowledge_graph", { p_id: focus }), [user.id, focus]);
  const [selected, setSelected] = useState(null);
  const [group, setGroup] = useState("");
  useEffect(() => setSelected(null), [focus]);
  const allNodes = r.data?.nodes || [];
  const groups = (r.data?.groups || []).filter((g) =>
    g.concepts.some((id) => allNodes.some((n) => n.id === id)),
  );
  const currentGroup = groups.find((g) => g.id === group);
  const nodes = currentGroup ? allNodes.filter((n) => currentGroup.concepts.includes(n.id)) : allNodes,
    edges = r.data?.edges || [];
  const points = new Map(
    nodes.map((n, i) => {
      const angle = i * 2.399963229728653,
        radius = 40 + 210 * Math.sqrt(i / Math.max(1, nodes.length - 1));
      return [n.id, { x: 300 + Math.cos(angle) * radius, y: 280 + Math.sin(angle) * radius }];
    }),
  );
  const active = nodes.find((n) => n.id === selected);
  const linked = edges.filter((e) => e.source === selected || e.target === selected);
  return (
    <Resource
      resource={r}
      loadingText="Loading knowledge…"
      errorMessage="Unable to load knowledge. Please try again."
      retryLabel="Try again"
    >
      {!nodes.length ? (
        <div className="reader-empty">
          The map will appear as concepts are indexed from available full texts.
        </div>
      ) : (
        <>
          <p className="reader-muted">
            Select a concept to explore related topics. Lines connect concepts studied in the same paper; they
            do not measure treatment effects or strength of evidence.
          </p>
          {!!groups.length && (
            <div className="knowledge-group-picker">
              <label htmlFor="knowledge-group">Topic groups</label>
              <select
                id="knowledge-group"
                value={currentGroup?.id || ""}
                onChange={(e) => {
                  setGroup(e.target.value);
                  setSelected(null);
                }}
              >
                <option value="">All groups</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {allNodes.find((n) => n.id === g.id)?.label ||
                      allNodes.find((n) => g.concepts.includes(n.id))?.label ||
                      "Topic group"}
                  </option>
                ))}
              </select>
              <p className="reader-muted">
                Groups reflect concepts occurring together. Only groups represented in this map are shown.
              </p>
            </div>
          )}
          <div className="knowledge-map-layout">
            <svg
              className="knowledge-map"
              viewBox="0 0 600 560"
              role="group"
              aria-label="Concept map from full texts"
            >
              {edges.map((e) => {
                const a = points.get(e.source),
                  b = points.get(e.target);
                if (!a || !b) return null;
                return (
                  <line
                    key={e.source + e.target}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={
                      selected && (e.source === selected || e.target === selected) ? "#2364aa" : "#cbd5e1"
                    }
                    strokeWidth={Math.min(4, 1 + Math.log2(e.weight + 1))}
                    opacity={selected && e.source !== selected && e.target !== selected ? 0.25 : 0.8}
                  />
                );
              })}
              {nodes.map((n, i) => {
                const p = points.get(n.id);
                return (
                  <g
                    key={n.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${n.label}, ${n.document_count} papers`}
                    aria-pressed={selected === n.id}
                    onClick={() => setSelected(n.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(n.id);
                      }
                    }}
                  >
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={selected === n.id ? 24 : 20}
                      fill={COLORS[n.kind] || COLORS.method}
                      stroke={selected === n.id ? "#111827" : "white"}
                      strokeWidth="3"
                    />
                    <text
                      x={p.x}
                      y={p.y + 5}
                      textAnchor="middle"
                      fill="white"
                      fontSize="15"
                      fontWeight="600"
                      aria-hidden="true"
                    >
                      {i + 1}
                    </text>
                  </g>
                );
              })}
            </svg>
            <div className="knowledge-map-info" aria-live="polite">
              {active ? (
                <>
                  <span className="knowledge-kind">{TYPES[active.kind]}</span>
                  <h2>{active.label}</h2>

                  <Link className="btn-primary" to={detailUrl(active.id)}>
                    Read knowledge page
                  </Link>
                  <h3>Related concepts</h3>
                  {!linked.length && <p>No connected concepts in this map.</p>}
                  <ul>
                    {linked.map((e) => {
                      const n = nodes.find((x) => x.id === (e.source === selected ? e.target : e.source));
                      return (
                        n && (
                          <li key={n.id}>
                            <button onClick={() => setSelected(n.id)}>{n.label}</button>
                            <span>{number(e.weight)} shared papers</span>
                          </li>
                        )
                      );
                    })}
                  </ul>
                </>
              ) : (
                <p>Select a concept on the map or in the list below.</p>
              )}
            </div>
          </div>
          <ol className="knowledge-node-list">
            {nodes.map((n, i) => (
              <li key={n.id}>
                <button aria-pressed={n.id === selected} onClick={() => setSelected(n.id)}>
                  <span className="knowledge-dot" style={{ background: COLORS[n.kind] }}>
                    {i + 1}
                  </span>
                  <span>
                    {n.label}
                    <small>{TYPES[n.kind]}</small>
                  </span>
                  <span>{number(n.document_count)} papers</span>
                </button>
              </li>
            ))}
          </ol>
          <p className="reader-muted">
            Showing up to 30{" "}
            {focus ? "concepts near the selected topic" : "concepts with the most connected papers"}. Find
            other concepts in Knowledge Explorer.
          </p>
        </>
      )}
    </Resource>
  );
}

export function KnowledgeLinks({ pmid }) {
  const { user } = useAuth();
  const r = useResource(
    () => rpc("knowledge_search", { p_query: "", p_pmid: pmid, p_page: 0 }),
    [user.id, pmid],
  );
  if (!r.data?.items?.length || r.error) return null;
  return (
    <div className="knowledge-inline" lang="en">
      <span>Related knowledge</span>
      {r.data.items.slice(0, 4).map((c) => (
        <Link key={c.id} to={detailUrl(c.id)}>
          {c.label}
        </Link>
      ))}
    </div>
  );
}

function KnowledgeDetail({ id }) {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const page = Math.max(0, Math.min(10000, Number(params.get("page")) || 0));
  const r = useResource(() => rpc("knowledge_page", { p_id: id, p_page: page }), [user.id, id, page]);
  const data = r.data;
  return (
    <ReaderPage lang="en" title={data?.concept?.label || "Knowledge page"}>
      <nav className="knowledge-nav">
        <Link to="/knowledge">Knowledge Explorer</Link>
        <Link to="/insights?view=knowledge">Literature Map</Link>
        <Link to="/discover">Discover</Link>
      </nav>
      <Resource
        resource={r}
        loadingText="Loading knowledge…"
        errorMessage="Unable to load knowledge. Please try again."
        retryLabel="Try again"
      >
        {data ? (
          <>
            <p className="reader-muted">
              {TYPES[data.concept.kind]} · {number(data.concept.document_count)} connected papers
            </p>
            {data.wiki?.status === "ready" && data.wiki.paragraphs.length ? (
              <article className="knowledge-article" aria-label="Source-based knowledge">
                <p className="knowledge-caption">
                  AI-generated synthesis of findings extracted from full texts. This page uses the sources
                  cited below, a selection of the connected papers. It is not a systematic review.
                </p>
                {data.wiki.paragraphs.map((p, i) => (
                  <section key={i}>
                    <p>{p.text}</p>
                    <div className="knowledge-citations">
                      {p.sources.map((s) => (
                        <Link
                          key={s.pmid}
                          to={`/fulltext/${s.pmid}?source=${encodeURIComponent(s.content_hash)}#${encodeURIComponent(s.locations[0])}`}
                        >
                          Source · PMID {s.pmid}
                        </Link>
                      ))}
                    </div>
                  </section>
                ))}
                <p className="knowledge-caption">Updated {date(data.wiki.updated_at)}</p>
              </article>
            ) : (
              <p className="reader-empty" role="status">
                {data.wiki?.status === "updating"
                  ? "This knowledge page is being updated. You can explore its connected papers below."
                  : data.wiki?.status === "indexed"
                    ? "This concept is indexed from full texts. Connected papers are available, but there are not yet enough verified findings for a narrative page."
                    : "This knowledge page is being prepared. You can explore its connected papers now."}
              </p>
            )}
            {!!data.neighbors.length && (
              <section className="knowledge-section">
                <h2>Related topics</h2>
                <div className="knowledge-related">
                  {data.neighbors.map((n) => (
                    <Link to={detailUrl(n.id)} key={n.id}>
                      {n.label}
                      <small>{number(n.shared_papers)} shared papers</small>
                    </Link>
                  ))}
                </div>
                <Link to={"/insights?view=knowledge&concept=" + data.concept.id}>
                  Explore nearby concepts
                </Link>
              </section>
            )}
            <section className="knowledge-section">
              <h2>Connected papers</h2>
              <p className="reader-muted">
                Check the population and study context in each paper. Paper counts may differ from the number
                of independent studies.
              </p>
              {data.papers.slice(0, 20).map((p) => (
                <article className="reader-card" key={p.pmid}>
                  <h3>
                    <Link to={"/papers/" + p.pmid}>{p.title}</Link>
                  </h3>
                  <p className="reader-muted">
                    {p.journal} · {p.pub_date}
                  </p>
                  <Link to={"/fulltext/" + p.pmid}>Read full text</Link>
                </article>
              ))}
              <Pager
                page={page}
                more={data.papers.length > 20}
                change={(next) => setParams(next ? { page: next } : {})}
              />
            </section>
          </>
        ) : (
          <p className="reader-empty">
            No current papers are connected to this concept. Search again in Knowledge Explorer.
          </p>
        )}
      </Resource>
    </ReaderPage>
  );
}

function KnowledgeBrowse() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") || "",
    page = Math.max(0, Math.min(1000, Number(params.get("page")) || 0));
  const [draft, setDraft] = useState(query);
  useEffect(() => setDraft(query), [query]);
  const r = useResource(
    () => rpc("knowledge_search", { p_query: query.slice(0, 200), p_page: page }),
    [user.id, query, page],
  );
  return (
    <ReaderPage
      lang="en"
      title="Knowledge Explorer"
      description="Explore concepts and research findings connected across available full texts."
    >
      <nav className="knowledge-nav">
        <Link to="/discover">Discover</Link>
        <Link to="/insights?view=knowledge">Literature Map</Link>
      </nav>
      <form
        className="knowledge-search"
        onSubmit={(e) => {
          e.preventDefault();
          setParams(draft.trim() ? { q: draft.trim() } : {});
        }}
      >
        <label htmlFor="knowledge-query">Search concepts, conditions and treatments</label>
        <div>
          <input
            id="knowledge-query"
            maxLength={200}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. prostate cancer, active surveillance"
          />
          <button className="btn-primary" type="submit">
            Search
          </button>
        </div>
      </form>
      <Resource
        resource={r}
        loadingText="Loading knowledge…"
        errorMessage="Unable to load knowledge. Please try again."
        retryLabel="Try again"
      >
        {r.data && (
          <>
            <p className="reader-muted">
              Indexed full texts: {number(r.data.indexed_documents)}
              {r.data.updated_at && ` · Updated ${date(r.data.updated_at)}`}
            </p>
            {!r.data.items.length && (
              <div className="reader-empty">
                {query
                  ? "No matching concepts. Try another term or use Discover."
                  : "Knowledge is being built from full texts. Concepts will appear as they are processed."}
              </div>
            )}
            <div className="knowledge-grid">
              {r.data.items.slice(0, 20).map((c) => (
                <article className="knowledge-card" key={c.id}>
                  <span className="knowledge-kind">{TYPES[c.kind]}</span>
                  <h2>
                    <Link to={detailUrl(c.id)}>{c.label}</Link>
                  </h2>

                  <div className="knowledge-caption">
                    <span>{number(c.document_count)} connected papers</span>
                    <span>
                      {c.status === "ready" ? "Knowledge page available" : "Connected papers available"}
                    </span>
                  </div>
                </article>
              ))}
            </div>
            <Pager
              page={page}
              more={r.data.items.length > 20}
              change={(next) =>
                setParams({ ...(query ? { q: query } : {}), ...(next ? { page: next } : {}) })
              }
            />
          </>
        )}
      </Resource>
    </ReaderPage>
  );
}

export default function Knowledge() {
  const { id } = useParams();
  return id ? <KnowledgeDetail key={id} id={id} /> : <KnowledgeBrowse />;
}
