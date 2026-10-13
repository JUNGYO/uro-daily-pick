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
    if (next.get("concept")) next.set("scopeConcept", next.get("concept"));
    if (next.get("with")) next.set("scopePeer", next.get("with"));
    next.set("relation", "citations");
    next.delete("concept");
    next.delete("with");
  } else {
    next.delete("relation");
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
