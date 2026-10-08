import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { rpc } from "../lib/workspace";
import { ReaderPage, Resource, useResource } from "../components/ReaderUI";
import { ScientificPaper } from "../components/KnowledgeEvidence";
import "../knowledge.css";

import { CATEGORY_LABELS as TYPES, CATEGORY_COLORS as COLORS } from "../lib/researchNetwork";
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
              {TYPES[data.concept.kind] || "Unresolved term"} · {number(data.concept.document_count)}{" "}
              connected papers
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
                <ScientificPaper key={p.pmid} paper={p} />
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
                  <span className="knowledge-kind">{TYPES[c.kind] || "Unresolved term"}</span>
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
