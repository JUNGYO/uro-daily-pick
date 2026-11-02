// Community membership is derived from the complete filtered full-text graph.
// A clicked concept/group changes the evidence pane, never the clustering input.
export function communityRequestFilters(filters) {
  const next = { ...filters, graph: true, relation: "concepts", min_shared: 1, page: 0 };
  for (const key of [
    "focus",
    "peer",
    "scope_concept",
    "scope_peer",
    "group_entities",
    "scope_entities",
    "category",
    "prefix",
    "scope_category",
    "scope_prefix",
    "citation_page",
    "unlinked_page",
    "direction",
    "limit",
  ])
    delete next[key];
  return next;
}

// Never expose an unscoped paper list while a selected group's evidence loads,
// or after the graph has lost access to its underlying research scope.
export function communityScopeResource(graph, scoped, { usesScopedData, invalidCluster }) {
  const resource = usesScopedData ? scoped : graph;
  const error =
    graph.error ||
    (invalidCluster
      ? "This research group is no longer available under the current filters. Return to the whole map."
      : resource.error);
  return {
    ...resource,
    data: error || (usesScopedData && !resource.data) ? null : resource.data,
    loading: !error && (graph.loading || (usesScopedData && (resource.loading || !resource.data))),
    refreshing: graph.refreshing || (usesScopedData && resource.refreshing),
    error,
    refreshError: graph.refreshError || resource.refreshError,
    reload: () => {
      graph.reload();
      if (usesScopedData) scoped.reload();
    },
  };
}
