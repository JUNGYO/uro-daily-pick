// Browsing changes the visible detail, never a top-N analytical sample.
const clearPages = (next) => {
  ["page", "unlinkedPage", "citationPage", "direction", "limit"].forEach((key) => next.delete(key));
  return next;
};

export function browseConceptMap(params, drill = {}) {
  const next = clearPages(new URLSearchParams(params));
  for (const key of ["category", "prefix", "cluster"]) {
    if (drill[key]) next.set(key, drill[key]);
    else next.delete(key);
  }
  return next;
}

export function selectConceptMap(params, id) {
  const next = browseConceptMap(params);
  if (params.get("cluster")) next.set("cluster", params.get("cluster"));
  const focus = next.get("concept");
  if (focus && focus !== id) next.set("with", id);
  else {
    next.set("concept", id);
    next.delete("with");
  }
  return next;
}

export function resetConceptMap(params) {
  const next = browseConceptMap(params);
  next.delete("concept");
  next.delete("with");
  return next;
}
