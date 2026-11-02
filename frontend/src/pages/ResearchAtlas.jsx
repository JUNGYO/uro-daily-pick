import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Network, Search, SlidersHorizontal, ArrowUpRight, X, ChevronLeft, ChevronRight } from "lucide-react";
import { useAuth } from "../lib/auth";
import { rpc, safeReturn } from "../lib/workspace";
import { Resource } from "../components/ReaderUI";
import { useRefreshingResource as useResource } from "../lib/useRefreshingResource";
import KnowledgeRefresh from "../components/KnowledgeRefresh";
import { ENGLISH_RESOURCE, KnowledgeNarrative, ScientificPaper } from "../components/KnowledgeEvidence";
import "../knowledge.css";
import { switchRelationship } from "../lib/researchNavigation";
import ConceptAtlas from "../components/ConceptAtlas";
import CitationNetwork from "../components/CitationNetwork";
import { CATEGORY_LABELS, categoryColor } from "../lib/researchNetwork";
import { browseConceptMap, resetConceptMap, selectConceptMap } from "../lib/conceptNavigation";
import { buildConceptCommunityTree } from "../lib/conceptCommunities";
import { communityRequestFilters, communityScopeResource } from "../lib/conceptCommunityScope";

const num = (n) => Number(n || 0).toLocaleString("en-US");
const THIS_YEAR = new Date().getFullYear();
function ConceptPreview({ data, returnTo }) {
  const item = data.selection,
    peer = data.selection_peer;
  if (!item) return <p>This concept has no papers under the current filters.</p>;
  if (peer) {
    const shared = Number(data.selection_documents ?? data.selected_documents),
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
        {item.concept_ui
          ? `MeSH ${item.vocabulary_year} · ${item.concept_ui} · Full term or definition verified within each paper`
          : item.resolution === "definition"
            ? "Expanded from an explicit definition in the source paper. No MeSH category is assigned."
            : "No unambiguous MeSH match. Undeclared abbreviations are kept separate by paper; identical long-form labels are grouped."}
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
            <p className="atlas-footnote">
              Knowledge narrative from the indexed corpus. The paper list and year chart below follow your
              current research scope.
            </p>
            <KnowledgeNarrative wiki={n.wiki} />
            <Link
              className="atlas-text-link"
              to={`/knowledge/${n.concept_id}?${new URLSearchParams({ returnTo })}`}
            >
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
        <p>Publication years of the indexed papers in the current selection</p>
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
  const location = useLocation();
  const returnTo = location.pathname + location.search;
  const [params, setParams] = useSearchParams();
  const selected = params.get("concept") || null,
    query = params.get("q") || "",
    journal = params.get("journal") || "",
    design = params.get("design") || "";
  const from = Math.max(2000, Math.min(2100, Number(params.get("from")) || 2000)),
    to = Math.max(from, Math.min(2100, Number(params.get("to")) || THIS_YEAR));
  const page = Math.max(0, Math.min(10000, Number(params.get("page")) || 0)),
    unlinkedPage = Math.max(0, Math.min(10000, Number(params.get("unlinkedPage")) || 0)),
    relation = params.get("relation") === "citations" ? "citations" : "concepts";
  const [draft, setDraft] = useState(query),
    [filters, setFilters] = useState(false);
  const peer = params.get("with") || null;
  const topic = params.get("scopeConcept") || null,
    topicPeer = params.get("scopePeer") || null;
  const project = params.get("project") || null,
    library = params.get("library") || null;
  const scopeQuery = params.get("scope_q") || "";
  const category = params.get("category") || "",
    prefix = params.get("prefix") || "",
    scopeCategory = params.get("scopeCategory") || "",
    scopePrefix = params.get("scopePrefix") || "";
  const cluster = params.get("cluster") || "",
    scopeCluster = params.get("scopeCluster") || "";
  const clusterPath = relation === "citations" ? scopeCluster : cluster;
  const citationPage = Math.max(0, Number(params.get("citationPage")) || 0);
  const direction = ["all", "references", "cited-by"].includes(params.get("direction"))
    ? params.get("direction")
    : "all";
  const needsStart =
    relation === "citations" &&
    !(
      selected ||
      topic ||
      scopeCategory ||
      scopeCluster ||
      project ||
      library ||
      query ||
      journal ||
      design ||
      params.has("from") ||
      params.has("to")
    );
  const minimum = [1, 2, 3, 5, 10].includes(Number(params.get("min"))) ? Number(params.get("min")) : 1;
  const limit = [30, 60, 100].includes(Number(params.get("limit"))) ? Number(params.get("limit")) : 60;
  useEffect(() => setDraft(query), [query]);
  const update = (fields) => {
    const next = new URLSearchParams(params);
    next.delete("page");
    next.delete("unlinkedPage");
    next.delete("citationPage");
    if (["q", "from", "to", "journal", "design"].some((key) => key in fields)) {
      for (const key of ["category", "prefix", "scopeCategory", "scopePrefix", "cluster", "scopeCluster"])
        next.delete(key);
    }
    if ("concept" in fields) next.delete("direction");
    next.delete("view");
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, String(v));
    }
    setParams(next);
  };
  const requestFilters = {
    q: query.slice(0, 200),
    from,
    to,
    journal,
    design,
    focus: selected,
    peer,
    page,
    unlinked_page: unlinkedPage,
    relation: needsStart ? "concepts" : relation,
    ...(topic ? { scope_concept: topic } : {}),
    ...(topicPeer ? { scope_peer: topicPeer } : {}),
    ...(project ? { project: Number(project) } : {}),
    ...(library ? { library, scope_q: scopeQuery } : {}),
    ...(relation === "citations" && !needsStart
      ? {
          citation_page: citationPage,
          direction,
          limit,
          ...(scopeCategory ? { scope_category: scopeCategory } : {}),
          ...(scopePrefix ? { scope_prefix: scopePrefix } : {}),
        }
      : { ...(category ? { category } : {}), ...(prefix ? { prefix } : {}) }),
    min_shared: minimum,
  };
  const graphFilters = communityRequestFilters(requestFilters);
  const graphKey = JSON.stringify([user.id, graphFilters]);
  const graph = useResource(
    async () => ({
      ...(await rpc("knowledge_concept_map", { p_filters: graphFilters })),
      _communityRequest: graphKey,
    }),
    [user.id, graphKey],
  );
  const graphData = graph.data?._communityRequest === graphKey ? graph.data : null;
  const currentGraph = { ...graph, data: graphData, loading: graph.loading || (!graphData && !graph.error) };
  const fullGraph = graphData?.map?.grouping === "full_graph" || graphData?.coverage?.all_graph === true;
  const legacyGraph = !!graphData && !fullGraph;
  useEffect(() => {
    if (!fullGraph || !(category || prefix || scopeCategory || scopePrefix)) return;
    const next = new URLSearchParams(params);
    ["category", "prefix", "scopeCategory", "scopePrefix"].forEach((key) => next.delete(key));
    setParams(next, { replace: true });
  }, [fullGraph, category, prefix, scopeCategory, scopePrefix, params, setParams]);
  const tree = useMemo(
    () => (fullGraph ? buildConceptCommunityTree(graphData) : null),
    [graphData, fullGraph],
  );
  const clusterMembers = useMemo(
    () => (clusterPath && tree ? tree.members(clusterPath) || [] : []),
    [tree, clusterPath],
  );
  const memberKey = clusterMembers.join(",");
  const scopeKey = JSON.stringify([user.id, requestFilters, clusterPath, memberKey, legacyGraph]);
  const scopeRequest = async (name, filters) => ({
    ...(await rpc(name, { p_filters: filters })),
    _communityScopeRequest: scopeKey,
  });
  const scoped = useResource(() => {
    if (legacyGraph) {
      return scopeRequest(
        relation === "citations" && !needsStart ? "knowledge_network" : "knowledge_concept_map",
        requestFilters,
      );
    }
    if (clusterPath && (!tree || !clusterMembers.length)) return Promise.resolve(null);
    if (relation === "citations" && !needsStart) {
      return scopeRequest("knowledge_network", {
        ...requestFilters,
        ...(clusterPath ? { scope_entities: clusterMembers } : {}),
      });
    }
    if (clusterPath || selected || peer || topic || topicPeer || page > 0) {
      return scopeRequest("knowledge_concept_map", {
        ...graphFilters,
        focus: selected,
        peer,
        page,
        ...(topic ? { scope_concept: topic } : {}),
        ...(topicPeer ? { scope_peer: topicPeer } : {}),
        ...(clusterPath ? { group_entities: clusterMembers } : {}),
      });
    }
    return Promise.resolve(null);
  }, [
    user.id,
    query,
    from,
    to,
    journal,
    design,
    selected,
    peer,
    page,
    unlinkedPage,
    relation,
    minimum,
    limit,
    topic,
    topicPeer,
    project,
    library,
    scopeQuery,
    citationPage,
    direction,
    needsStart,
    category,
    prefix,
    scopeCategory,
    scopePrefix,
    clusterPath,
    memberKey,
    Boolean(tree),
    legacyGraph,
  ]);
  const usesScopedData =
    legacyGraph ||
    !!(clusterPath || selected || peer || topic || topicPeer || page > 0) ||
    (relation === "citations" && !needsStart);
  const invalidCluster = !!clusterPath && !!tree && !clusterMembers.length;
  const currentScoped = {
    ...scoped,
    data: scoped.data?._communityScopeRequest === scopeKey ? scoped.data : null,
  };
  const r = communityScopeResource(currentGraph, currentScoped, { usesScopedData, invalidCluster });
  const graphView = useMemo(
    () => tree?.view(clusterPath, { selected, peer, minimum }),
    [tree, clusterPath, selected, peer, minimum],
  );
  const d =
    r.data && graphView && (relation === "concepts" || needsStart)
      ? {
          ...r.data,
          nodes: graphView?.nodes || [],
          edges: graphView?.edges || [],
          map: graphView?.map,
          coverage: graphView?.coverage || r.data.coverage,
        }
      : r.data;
  const activeFilters = !!(
    query ||
    journal ||
    design ||
    from !== 2000 ||
    to !== THIS_YEAR ||
    selected ||
    category ||
    scopeCategory ||
    cluster ||
    scopeCluster
  );
  const browse = (drill) => {
    const next = browseConceptMap(params, drill);
    if (drill?.cluster) {
      next.delete("concept");
      next.delete("with");
    }
    setParams(next);
  };
  const selectConcept = (id) => setParams(selectConceptMap(params, id));
  const resetMap = () => setParams(resetConceptMap(params));
  const mapBreadcrumbs = [
    { label: "All concepts", onClick: resetMap },
    ...(tree?.breadcrumbs(clusterPath) || []).map((item) => ({
      ...item,
      onClick: () => browse({ cluster: item.cluster }),
    })),
    ...(selected
      ? [
          {
            label: d?.selection?.label || "Selected concept",
            onClick: () => {
              const next = browseConceptMap(params, { cluster });
              next.delete("with");
              setParams(next);
            },
          },
        ]
      : []),
    ...(peer ? [{ label: d?.selection_peer?.label || "Shared papers", onClick: () => browse() }] : []),
    ...(legacyGraph ? d?.map?.breadcrumbs || [] : []).map((item) => ({
      ...item,
      label: !item.prefix ? CATEGORY_LABELS[item.category] || item.label : item.label,
      onClick: () => browse(item),
    })),
  ];
  return (
    <div className="atlas-page h-full overflow-y-auto" lang="en">
      <div className="atlas-container">
        <header className="atlas-header">
          <div>
            <span className="atlas-eyebrow">KNOWLEDGE & CONNECTIONS</span>
            <h1>Research atlas</h1>
            <p>Research connections from concepts found in full texts.</p>
          </div>
          <nav className="atlas-tabs" aria-label="Insights views">
            <Link aria-current="page" to="/insights">
              <Network size={17} />
              Research atlas
            </Link>
            <Link to="/insights?view=activity">My activity</Link>
          </nav>
        </header>
        {(project || library || topic || scopeCategory || scopeCluster || params.get("returnTo")) && (
          <nav className="atlas-research-context" aria-label="Research context">
            {params.get("returnTo") && (
              <Link to={safeReturn(params.get("returnTo"))}>← Back to reading workspace</Link>
            )}
            <span>
              {d?.context?.project_name
                ? `Project: ${d.context.project_name}`
                : project
                  ? "Project literature"
                  : library
                    ? `My library · ${library}`
                    : "Research atlas"}
            </span>
            {topic && (
              <span>
                Topic: {d?.context?.topic_label || "Selected concept"}
                {d?.context?.topic_peer_label ? ` × ${d.context.topic_peer_label}` : ""}
              </span>
            )}
            {scopeQuery && <span>Library search: {scopeQuery}</span>}
            {scopeCategory && (
              <span>Concept category: {CATEGORY_LABELS[scopeCategory] || scopeCategory}</span>
            )}
            {scopeCluster && (
              <span>
                Concept community: {tree?.breadcrumbs(scopeCluster).at(-1)?.label || "Selected group"}
              </span>
            )}
            {(project || library || topic) && <Link to="/insights">Explore all indexed literature</Link>}
          </nav>
        )}
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
              {selected ? (relation === "citations" ? " · Selected paper" : " · Selected concept") : ""}
            </span>
            <button
              onClick={() => {
                const next = new URLSearchParams(params);
                [
                  "q",
                  "journal",
                  "design",
                  "from",
                  "to",
                  "concept",
                  "with",
                  "page",
                  "unlinkedPage",
                  "citationPage",
                  "direction",
                  "category",
                  "prefix",
                  "scopeCategory",
                  "scopePrefix",
                  "cluster",
                  "scopeCluster",
                ].forEach((key) => next.delete(key));
                setParams(next);
              }}
            >
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
              {d.context?.scope_papers != null && (
                <p className="atlas-footnote">
                  {num(d.matched_documents)} indexed papers within the current filters ·{" "}
                  {num(d.context.scope_papers)} catalog-linked papers in this workspace
                  {d.context.unlinked_project_records > 0
                    ? ` · ${num(d.context.unlinked_project_records)} project records not linked to the catalog`
                    : ""}
                  . Papers without an indexed original remain in your workspace.
                </p>
              )}
              <KnowledgeRefresh resource={r} />
              <div
                className={`atlas-workbench${relation === "citations" ? " atlas-citation-workbench" : ""}`}
              >
                <section className="atlas-network-panel" aria-label="Research network">
                  <div className="atlas-network-heading">
                    <div>
                      <h2>
                        {relation === "concepts" && clusterPath
                          ? "Community connections"
                          : "Research connections"}
                      </h2>
                      <p>
                        {relation === "citations"
                          ? "Follow references through time. Select a paper to explore its connections."
                          : clusterPath
                            ? "Explore the concepts in this community and the papers they share. Groups contain all their member concepts."
                            : "Explore all concepts extracted from full texts, grouped by their shared papers. Open a community to see its concepts."}
                      </p>
                    </div>
                    <div className="atlas-segment" aria-label="Network relationship">
                      <button
                        aria-pressed={relation === "concepts"}
                        onClick={() => setParams(switchRelationship(params, "concepts"))}
                      >
                        Concepts
                      </button>
                      <button
                        aria-pressed={relation === "citations"}
                        onClick={() => setParams(switchRelationship(params, "citations"))}
                      >
                        Citations
                      </button>
                    </div>
                  </div>
                  {needsStart ? (
                    <div className="atlas-no-network">
                      <Network size={36} />
                      <h3>Choose a starting point for citations</h3>
                      <p>
                        Search for a paper or topic above, choose a paper below, or select a concept before
                        opening Citations. Your library and project maps keep their own literature scope.
                      </p>
                      <button onClick={() => setParams(switchRelationship(params, "concepts"))}>
                        Choose a concept
                      </button>
                    </div>
                  ) : relation === "citations" ? (
                    <CitationNetwork
                      data={d}
                      returnTo={returnTo}
                      view={params.get("citationView") === "timeline" ? "timeline" : "connections"}
                      setView={(value) => {
                        const next = new URLSearchParams(params);
                        next.set("citationView", value);
                        setParams(next);
                      }}
                      citationPage={citationPage}
                      setCitationPage={(value) => {
                        const next = new URLSearchParams(params);
                        next.set("citationPage", String(value));
                        setParams(next);
                      }}
                      direction={direction}
                      setDirection={(value) => update({ direction: value })}
                      selected={d.focus || selected}
                      peer={d.peer || peer}
                      select={(id) => update({ concept: id, with: null })}
                      selectEdge={(a, b) => update({ concept: a, with: b })}
                      limit={limit}
                      setLimit={(value) => update({ limit: value })}
                      page={unlinkedPage}
                      setPage={(value) => {
                        const next = new URLSearchParams(params);
                        next.set("unlinkedPage", String(value));
                        setParams(next);
                      }}
                    />
                  ) : d.nodes.length ? (
                    <ConceptAtlas
                      key={relation}
                      data={d}
                      selected={d.focus || selected}
                      peer={d.peer || peer}
                      onSelectConcept={selectConcept}
                      onSelectEdge={(a, b) => {
                        const next = browseConceptMap(params, { cluster });
                        next.set("concept", a);
                        next.set("with", b);
                        setParams(next);
                      }}
                      onDrill={(node) => browse(node.drill)}
                      breadcrumbs={mapBreadcrumbs}
                      onReset={resetMap}
                      minimum={minimum}
                      setMinimum={(min) => update({ min })}
                      loading={r.refreshing}
                    />
                  ) : (
                    <div className="atlas-no-network">
                      <Network size={36} />
                      <h3>
                        {d.selected_documents > 0
                          ? "No extracted concepts in this selection."
                          : activeFilters
                            ? "No indexed papers match these filters."
                            : project || library
                              ? "No indexed originals in this workspace yet."
                              : "The corpus is being indexed."}
                      </h3>
                      <p>
                        {d.selected_documents > 0
                          ? "These indexed papers remain available below. Their concepts have not been extracted yet."
                          : activeFilters
                            ? "Broaden your search or clear the filters."
                            : project || library
                              ? "Your saved papers remain available in the workspace. Connections appear when their originals are indexed."
                              : "Concepts and connections will appear as full texts are processed."}
                      </p>
                      {activeFilters && (
                        <button
                          onClick={() => {
                            const next = new URLSearchParams(params);
                            [
                              "q",
                              "journal",
                              "design",
                              "from",
                              "to",
                              "concept",
                              "with",
                              "page",
                              "unlinkedPage",
                              "citationPage",
                              "direction",
                              "category",
                              "prefix",
                              "scopeCategory",
                              "scopePrefix",
                              "cluster",
                              "scopeCluster",
                            ].forEach((key) => next.delete(key));
                            setParams(next);
                          }}
                        >
                          Clear filters
                        </button>
                      )}
                    </div>
                  )}
                </section>
                {relation !== "citations" && (
                  <aside className="atlas-detail" aria-label="Selected research" aria-live="polite">
                    {relation === "concepts" && selected ? (
                      <ConceptPreview data={d} returnTo={returnTo} />
                    ) : (
                      <>
                        <span className="atlas-eyebrow">START EXPLORING</span>
                        <h2>
                          {cluster
                            ? tree?.breadcrumbs(cluster).at(-1)?.label
                            : "Related concepts, supported by full texts."}
                        </h2>
                        <p>
                          {cluster
                            ? `${num(clusterMembers.length)} concepts in this community. `
                            : "Every extracted concept is represented. "}
                          Communities follow which concepts occur together in the same papers. Their labels
                          use actual member concepts. Select a concept to read its evidence, or a second
                          concept to inspect their shared literature.
                        </p>
                        <div className="atlas-topics">
                          {d.nodes.slice(0, 5).map((n) => (
                            <button
                              key={n.id}
                              onClick={() =>
                                n.node_type === "group" ? browse(n.drill) : selectConcept(n.id)
                              }
                            >
                              <i style={{ background: n.color || categoryColor(n.kind) }} />
                              <span>
                                {n.node_type === "group" && !n.drill?.cluster && !n.drill?.prefix
                                  ? CATEGORY_LABELS[n.kind] || n.label
                                  : n.label}
                              </span>
                              <ChevronRight size={16} />
                            </button>
                          ))}
                        </div>
                        <p className="atlas-footnote">
                          {relation === "citations"
                            ? "This map connects indexed papers to their identified references."
                            : "This map covers full texts whose concepts have been extracted."}{" "}
                          Community proximity reflects co-occurrence, not a clinical conclusion. Counts
                          describe papers, not independent studies.
                        </p>
                      </>
                    )}
                  </aside>
                )}
              </div>
              <Timeline years={d.years} choose={(year) => update({ from: year, to: year })} />
              <section className="atlas-paper-section">
                <div className="atlas-section-heading">
                  <div>
                    <span className="atlas-eyebrow">CONNECTED LITERATURE</span>
                    <h2>
                      {relation === "citations" && selected
                        ? "Indexed papers behind this citation"
                        : peer
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
                  <ScientificPaper
                    key={p.pmid}
                    paper={p}
                    returnTo={returnTo}
                    onCitations={() => {
                      const next =
                        relation === "concepts"
                          ? switchRelationship(params, "citations")
                          : new URLSearchParams(params);
                      next.set("relation", "citations");
                      next.set("concept", p.pmid);
                      ["with", "citationPage", "direction", "page"].forEach((key) => next.delete(key));
                      setParams(next);
                    }}
                  />
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
