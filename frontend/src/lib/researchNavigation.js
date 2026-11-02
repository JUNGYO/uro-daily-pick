import { safeReturn } from "./workspace";

export function atlasLink({ paper, project, library, query, returnTo } = {}) {
  const params = new URLSearchParams();
  if (paper) {
    params.set("relation", "citations");
    params.set("concept", String(paper));
  }
  if (project) params.set("project", String(project));
  if (library) params.set("library", library);
  if (query && library) params.set("scope_q", query);
  if (returnTo) {
    const source = new URL(safeReturn(returnTo), "https://local.invalid");
    const previous = source.searchParams.get("returnTo");
    if (previous) {
      const parent = new URL(safeReturn(previous), "https://local.invalid");
      parent.searchParams.delete("returnTo");
      source.searchParams.set("returnTo", parent.pathname + parent.search);
    }
    params.set("returnTo", source.pathname + source.search);
  }
  return "/insights" + (params.size ? "?" + params : "");
}

export function switchRelationship(params, relation) {
  const next = new URLSearchParams(params);
  if ((next.get("relation") === "citations" ? "citations" : "concepts") === relation) return next;
  ["page", "unlinkedPage", "citationPage", "direction"].forEach((key) => next.delete(key));
  if (relation === "citations") {
    if (next.get("cluster")) next.set("scopeCluster", next.get("cluster"));
    next.delete("cluster");
    if (next.get("category")) next.set("scopeCategory", next.get("category"));
    if (next.get("prefix")) next.set("scopePrefix", next.get("prefix"));
    next.delete("category");
    next.delete("prefix");
    if (next.get("concept")) next.set("scopeConcept", next.get("concept"));
    if (next.get("with")) next.set("scopePeer", next.get("with"));
    next.set("relation", "citations");
    next.delete("concept");
    next.delete("with");
  } else {
    if (next.get("scopeCluster")) next.set("cluster", next.get("scopeCluster"));
    else next.delete("cluster");
    next.delete("scopeCluster");
    next.delete("relation");
    if (next.get("scopeCategory")) next.set("category", next.get("scopeCategory"));
    else next.delete("category");
    if (next.get("scopePrefix")) next.set("prefix", next.get("scopePrefix"));
    else next.delete("prefix");
    next.delete("scopeCategory");
    next.delete("scopePrefix");
    if (next.get("scopeConcept")) next.set("concept", next.get("scopeConcept"));
    else next.delete("concept");
    if (next.get("scopePeer")) next.set("with", next.get("scopePeer"));
    else next.delete("with");
    next.delete("scopeConcept");
    next.delete("scopePeer");
  }
  return next;
}

export function paperFromAtlas(pmid, atlasPath) {
  return `/papers/${pmid}?${new URLSearchParams({ returnTo: safeReturn(atlasPath) })}`;
}

export function paperAtlasLink(paper, back, returnTo) {
  const origin = new URL(safeReturn(back), "https://local.invalid");
  if (origin.pathname !== "/insights" || origin.searchParams.get("view") === "activity") {
    const paperReturn = new URL(safeReturn(returnTo), "https://local.invalid");
    if (back) paperReturn.searchParams.set("returnTo", origin.pathname + origin.search);
    return atlasLink({ paper, returnTo: paperReturn.pathname + paperReturn.search });
  }
  const next = switchRelationship(origin.searchParams, "citations");
  next.set("concept", String(paper));
  ["with", "page", "unlinkedPage", "citationPage", "direction"].forEach((key) => next.delete(key));
  return "/insights?" + next;
}
