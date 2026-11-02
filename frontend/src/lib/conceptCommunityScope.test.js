import { describe, expect, it, vi } from "vitest";
import { communityRequestFilters, communityScopeResource } from "./conceptCommunityScope";

const resource = (data, extra = {}) => ({
  data,
  loading: false,
  refreshing: false,
  error: "",
  refreshError: "",
  reload: vi.fn(),
  ...extra,
});

describe("community evidence scope", () => {
  it("keeps the full filtered graph stable while selecting concepts, groups, or citation papers", () => {
    expect(
      communityRequestFilters({
        q: "prostate",
        from: 2020,
        to: 2026,
        project: 7,
        library: "saved",
        scope_q: "trial",
        focus: "concept-a",
        peer: "concept-b",
        scope_concept: "concept-c",
        scope_peer: "concept-d",
        group_entities: ["a"],
        scope_entities: ["b"],
        category: "substance",
        prefix: "0",
        scope_category: "condition",
        scope_prefix: "1",
        min_shared: 10,
        limit: 30,
        relation: "citations",
        page: 3,
        unlinked_page: 4,
        citation_page: 2,
        direction: "references",
      }),
    ).toEqual({
      q: "prostate",
      from: 2020,
      to: 2026,
      project: 7,
      library: "saved",
      scope_q: "trial",
      graph: true,
      relation: "concepts",
      min_shared: 1,
      page: 0,
    });
  });
  it("does not show the whole-corpus paper list while community evidence is pending", () => {
    const graph = resource({ selected_documents: 5000 });
    const result = communityScopeResource(graph, resource(null), { usesScopedData: true });
    expect(result.loading).toBe(true);
    expect(result.data).toBeNull();
  });
  it("uses scoped evidence without replacing it with base-graph counts", () => {
    const graph = resource({ selected_documents: 5000 });
    const scoped = resource({ selected_documents: 24, years: [{ year: 2025, papers: 24 }] });
    const result = communityScopeResource(graph, scoped, { usesScopedData: true });
    expect(result.data).toBe(scoped.data);
    expect(result.loading).toBe(false);
    result.reload();
    expect(graph.reload).toHaveBeenCalledOnce();
    expect(scoped.reload).toHaveBeenCalledOnce();
  });
  it("clears evidence if graph access is denied or a group no longer exists", () => {
    const scoped = resource({ papers: ["private paper"] });
    const denied = communityScopeResource(resource(null, { error: "Access denied" }), scoped, {
      usesScopedData: true,
    });
    expect(denied.data).toBeNull();
    expect(denied.error).toBe("Access denied");
    const missing = communityScopeResource(resource({ nodes: [] }), scoped, {
      usesScopedData: true,
      invalidCluster: true,
    });
    expect(missing.data).toBeNull();
    expect(missing.loading).toBe(false);
    expect(missing.error).toMatch(/Return to the whole map/);
  });
});
