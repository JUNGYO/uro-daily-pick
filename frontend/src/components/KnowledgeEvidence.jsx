import { useState } from "react";
import { Link } from "react-router-dom";
import { rpc } from "../lib/workspace";
import { Resource, useResource } from "./ReaderUI";

export const ENGLISH_RESOURCE = {
  loadingText: "Loading research…",
  errorMessage: "Unable to load research. Please try again.",
  retryLabel: "Try again",
};
const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-US") : "Not recorded");
export function SourceLink({ pmid, hash, locations, children = "View source" }) {
  return (
    <Link
      to={`/fulltext/${pmid}?source=${encodeURIComponent(hash)}#${encodeURIComponent(locations?.[0] || "")}`}
    >
      {children}
    </Link>
  );
}

export function KnowledgeNarrative({ wiki }) {
  if (wiki?.status !== "ready" || !wiki.paragraphs?.length)
    return (
      <p className="atlas-empty" role="status">
        {wiki?.status === "updating"
          ? "This knowledge page is being updated. Connected papers remain available."
          : "Connected papers are available. A source-based narrative has not yet been published."}
      </p>
    );
  return (
    <article className="atlas-narrative" aria-label="Source-based knowledge">
      {wiki.paragraphs.map((p, i) => (
        <section key={i}>
          <p>{p.text}</p>
          <div className="atlas-citations">
            {p.sources.map((s) => (
              <SourceLink key={s.pmid} pmid={s.pmid} hash={s.content_hash} locations={s.locations}>
                PMID {s.pmid}
              </SourceLink>
            ))}
          </div>
        </section>
      ))}
      <p className="atlas-footnote">
        AI synthesis · Updated {formatDate(wiki.updated_at)} · Uses a selection of connected papers; not a
        systematic review.
      </p>
    </article>
  );
}

const FACT_LABELS = {
  design: "Design",
  population: "Population",
  intervention: "Intervention",
  comparator: "Comparator",
  sample_size: "Sample size",
  follow_up: "Follow-up",
  outcome: "Outcome",
  limitation: "Limitation",
};
function ScientificRecord({ pmid }) {
  const r = useResource(() => rpc("knowledge_paper", { p_pmid: pmid }), [pmid]);
  const d = r.data,
    s = d?.science,
    b = s?.bibliography;
  return (
    <Resource resource={r} {...ENGLISH_RESOURCE}>
      {d && (
        <div className="atlas-science">
          <section aria-label="Bibliographic record">
            <h4>Bibliographic record</h4>
            <p>{(b?.authors || d.authors || []).join(", ") || "Authors not recorded"}</p>
            <p>
              {b?.journal || d.journal} {b?.volume || d.volume}
              {b?.issue || d.issue ? ` (${b?.issue || d.issue})` : ""}
              {b?.pages || d.pages ? `: ${b?.pages || d.pages}` : ""}
            </p>
            <div className="atlas-citations">
              <a href={`https://pubmed.ncbi.nlm.nih.gov/${pmid}/`} target="_blank" rel="noreferrer">
                PMID {pmid}
              </a>
              {(b?.doi || d.doi) && (
                <a
                  href={`https://doi.org/${encodeURIComponent(b?.doi || d.doi)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  DOI
                </a>
              )}
              {b?.pmcid && (
                <a
                  href={`https://pmc.ncbi.nlm.nih.gov/articles/${encodeURIComponent(b.pmcid)}/`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {b.pmcid}
                </a>
              )}
            </div>
            <dl className="atlas-facts">
              {(b?.dates || [{ kind: "Catalog date", date: d.pub_date, precision: "unknown" }]).map(
                (v, i) => (
                  <div key={i}>
                    <dt>{v.kind.replaceAll("_", " ")}</dt>
                    <dd>
                      {v.precision === "range" ? v.raw : v.date || "Not recorded"}
                      <small>
                        {v.precision === "unknown"
                          ? "Date precision not recorded"
                          : `${v.precision} precision`}
                      </small>
                    </dd>
                  </div>
                ),
              )}
            </dl>
            <p className="atlas-footnote">
              {(b?.publication_types || d.publication_types || []).join(" · ") ||
                "Publication type not recorded"}
            </p>
          </section>
          {!s ? (
            <p className="atlas-empty">
              Structured extraction is pending. No missing field is inferred from the summary.
            </p>
          ) : (
            <>
              <section aria-label="Study context">
                <h4>Study context</h4>
                <dl className="atlas-facts">
                  {Object.entries(FACT_LABELS).map(([key, label]) => {
                    const rows = s.facts.filter((f) => f.field === key);
                    return (
                      <div key={key}>
                        <dt>{label}</dt>
                        <dd>
                          {rows.length ? (
                            rows.map((f) => (
                              <p key={f.id}>
                                {f.value}{" "}
                                <SourceLink pmid={pmid} hash={d.content_hash} locations={f.locations} />
                              </p>
                            ))
                          ) : (
                            <span className="atlas-missing">Not extracted</span>
                          )}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
              <section aria-label="Reported results">
                <h4>
                  Reported results <span>{s.results.length}</span>
                </h4>
                {!s.results.length && (
                  <p className="atlas-missing">No source-checked numerical result has been extracted.</p>
                )}
                {s.results.map((v) => (
                  <article className="atlas-result" key={v.id}>
                    <strong>{v.outcome || "Outcome not extracted"}</strong>
                    <p className="atlas-estimate">
                      {v.measure}{" "}
                      <b>
                        {v.estimate}
                        {v.unit ? ` ${v.unit}` : ""}
                      </b>
                      {v.ci_low !== null && (
                        <span>
                          {v.ci_level}% CI {v.ci_low}–{v.ci_high}
                        </span>
                      )}
                    </p>
                    <dl>
                      <div>
                        <dt>Population</dt>
                        <dd>{v.population || "Not extracted"}</dd>
                      </div>
                      <div>
                        <dt>Comparison</dt>
                        <dd>{v.comparison || "Not extracted"}</dd>
                      </div>
                      <div>
                        <dt>Timepoint</dt>
                        <dd>{v.timepoint || "Not extracted"}</dd>
                      </div>
                      <div>
                        <dt>Adjustment</dt>
                        <dd>{v.adjustment.replaceAll("_", " ")}</dd>
                      </div>
                    </dl>
                    <SourceLink pmid={pmid} hash={d.content_hash} locations={v.locations} />
                  </article>
                ))}
                <p className="atlas-footnote">
                  Values belong to their reported populations and comparisons. They are not pooled estimates.
                  Source checks do not establish clinical validity.
                </p>
              </section>
              {!!s.terminology.length && (
                <section>
                  <h4>Standard terminology</h4>
                  <div className="atlas-citations">
                    {s.terminology.map((t) => (
                      <a
                        key={`${t.concept_id}-${t.id}`}
                        href={`https://meshb.nlm.nih.gov/record/ui?ui=${t.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t.label} · MeSH {t.id}
                      </a>
                    ))}
                  </div>
                </section>
              )}
              {!!d.related_reports?.length && (
                <section>
                  <h4>Reports with a shared registry identifier</h4>
                  <p className="atlas-footnote">
                    Candidate links only. A shared identifier or mention does not establish that populations
                    are identical or independent.
                  </p>
                  {d.related_reports.map((p, i) => (
                    <p key={i}>
                      <Link to={`/papers/${p.pmid}`}>{p.title}</Link>
                      <small>
                        {p.registry_id} · {p.source_relation} / {p.target_relation}
                      </small>
                    </p>
                  ))}
                </section>
              )}
              <details className="atlas-provenance">
                <summary>Sources and extraction record</summary>
                <p>
                  {s.provenance.model} · {s.provenance.recipe}
                </p>
                <p>
                  Extracted {formatDate(s.provenance.extracted_at)} · Machine source checks · Not human
                  reviewed
                </p>
                <p>
                  {s.provenance.chunks} source segments processed · {s.provenance.rejected_candidates}{" "}
                  unsupported candidates omitted
                </p>
                <p>
                  Showing {s.coverage.facts_published} of {s.coverage.facts_total} extracted context fields
                  and {s.coverage.results_published} of {s.coverage.results_total} numerical results.
                </p>
                <p>
                  Bibliography: {b.source}
                  {b.fetched_at ? ` · Retrieved ${formatDate(b.fetched_at)}` : " · Detailed metadata pending"}
                </p>
                <p className="atlas-hash">Source SHA-256: {d.content_hash}</p>
                <h4>Identified cited references ({b.references.length})</h4>
                {!b.references.length && (
                  <p>
                    No reference identifiers were supplied by the metadata source. This does not mean the
                    article has no references.
                  </p>
                )}
                <ol>
                  {b.references.map((ref, i) => (
                    <li key={i}>
                      {ref.pmid ? (
                        <a
                          href={`https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}/`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          PMID {ref.pmid}
                        </a>
                      ) : (
                        <a
                          href={`https://doi.org/${encodeURIComponent(ref.doi)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {ref.doi}
                        </a>
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            </>
          )}
        </div>
      )}
    </Resource>
  );
}

export function ScientificPaper({ paper }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="atlas-paper">
      <div className="atlas-paper-meta">
        <span>{paper.pub_date?.slice(0, 4) || "Year unknown"}</span>
        <span>{paper.journal || "Journal not recorded"}</span>
        {paper.study_type && <span>{paper.study_type.replaceAll("_", " ")}</span>}
      </div>
      <h3>
        <Link to={`/papers/${paper.pmid}`}>{paper.title}</Link>
      </h3>
      <div className="atlas-paper-actions">
        <button aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide research record" : "Research record"}
        </button>
        <Link to={`/fulltext/${paper.pmid}`}>Read full text ↗</Link>
        <span>PMID {paper.pmid}</span>
      </div>
      {open && <ScientificRecord pmid={paper.pmid} />}
    </article>
  );
}
