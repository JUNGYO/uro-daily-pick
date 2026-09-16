import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ProjectLiteratureViews from "./ProjectLiteratureViews";
import ResearchWorkspace from "./ResearchWorkspace";

const api = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../lib/workspace", () => ({ rpc: api.rpc }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { id: "project-reader" } }) }));
vi.mock("../lib/googleDocsExport", () => ({ googleDocsConfigured: () => false }));
const references = [
  {
    id: 1,
    bibliography: { pmid: "40000001", title: "Prostate trial" },
    paper: { mesh_terms: ["Prostatic Neoplasms"], study_type: "rct", summary_ready: true },
    auto_values: { outcome: "Outcome from source" },
    source_content_hash: "hash",
    extraction_status: "complete",
    evidence: { outcome: ["p-0000001"] },
  },
  {
    id: 2,
    bibliography: { pmid: "40000002", title: "Metadata only" },
    paper: { mesh_terms: [], study_type: "ai" },
  },
];
const topics = [
  {
    id: 3,
    title: "Writing argument",
    section: "introduction",
    body: "A user-written argument",
    reference_ids: [1],
    cell_links: [{ reference_id: 1, column_id: "outcome" }],
  },
];
const response = { references, topics, total: 74, topic_total: 1, truncated: true, limit: 50 };
let props;
const element = (overrides = {}) => (
  <MemoryRouter>
    <ProjectLiteratureViews {...props} {...overrides} />
  </MemoryRouter>
);
beforeEach(() => {
  api.rpc.mockReset().mockResolvedValue(response);
  props = {
    projectId: 7,
    filter: "",
    view: "table",
    onViewChange: vi.fn(),
    columns: [{ id: "outcome", label: "결과" }],
    onShowReference: vi.fn(),
    onShowTopic: vi.fn(),
    onError: vi.fn(),
  };
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("project literature views", () => {
  it("keeps the table default and fetches only bounded project data when another view opens", async () => {
    const result = render(element());
    expect(api.rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "분포", exact: true }));
    expect(props.onViewChange).toHaveBeenCalledWith("distribution");
    result.rerender(element({ view: "distribution", filter: "prostate" }));
    await screen.findByText(/표시 문헌 2 \/ 검색 범위 74편/);
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith("research_graph", {
      p_id: 7,
      p_query: "prostate",
      p_limit: 50,
    });
    expect(screen.getByText(/전체 프로젝트의 분포로 해석하지 마세요/)).toBeInTheDocument();
  });

  it("opens existing source, table cell and writing details from explicit links", async () => {
    const result = render(element({ view: "network" }));
    await screen.findByText(/표시 문헌 2/);
    const canvas = result.container.querySelector(".project-network-canvas");
    fireEvent.click(within(canvas).getByRole("button", { name: /집필 논점 Writing argument/ }));
    const detail = screen.getByRole("region", { name: "선택한 자료 상세" });
    expect(within(detail).getByText("A user-written argument")).toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: "본문 근거 1 보기 ↗" })).toHaveAttribute(
      "href",
      "/fulltext/40000001?source=hash#p-0000001",
    );
    fireEvent.click(within(detail).getByRole("button", { name: "표 항목 · 결과" }));
    expect(props.onShowReference).toHaveBeenCalledWith(references[0], "outcome");
    fireEvent.click(within(detail).getByRole("button", { name: "서론 논점에서 보기" }));
    expect(props.onShowTopic).toHaveBeenCalledWith(topics[0]);
    fireEvent.click(within(detail).getByRole("button", { name: /사용자가 연결한 자료 Prostate trial/ }));
    expect(within(detail).getByRole("link", { name: /원문·근거 보기/ })).toHaveAttribute(
      "href",
      "/papers/40000001?tab=study",
    );
    expect(within(detail).getByText("본문 기반 요약")).toBeInTheDocument();
    expect(screen.getByText(/인용·인과 관계는 표시하지 않습니다/)).toBeInTheDocument();
  });

  it("provides a selectable list and retains paper selection across table toggles", async () => {
    const result = render(element({ view: "network" }));
    await screen.findByText(/표시 문헌 2/);
    fireEvent.click(screen.getByRole("button", { name: "목록으로 보기" }));
    const list = screen.getByLabelText("연결 지도 목록");
    fireEvent.click(within(list).getByRole("button", { name: /Metadata only 서지 정보/ }));
    expect(
      within(screen.getByRole("region", { name: "선택한 자료 상세" })).getByText("서지 정보 · 원문 미확인"),
    ).toBeInTheDocument();
    result.rerender(element());
    expect(screen.queryByRole("region", { name: "선택한 자료 상세" })).not.toBeInTheDocument();
    result.rerender(element({ view: "network" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "선택한 자료 상세" })).getByRole("heading", {
          name: "Metadata only",
        }),
      ).toBeInTheDocument(),
    );
  });

  it("ignores an obsolete project response and does not retain its private labels", async () => {
    let resolveOld;
    api.rpc
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue({ references: [], topics: [], total: 0, topic_total: 0 });
    const result = render(element({ view: "network" }));
    result.rerender(element({ projectId: 8, view: "network" }));
    await screen.findByText("이 검색 범위에 표시할 프로젝트 문헌이 없습니다.");
    await act(async () => {
      resolveOld(response);
    });
    expect(screen.queryByText("Writing argument")).not.toBeInTheDocument();
    expect(screen.getByText(/표시 문헌 0 \/ 검색 범위 0편/)).toBeInTheDocument();
  });

  it("reports authorization loss without rendering a previous graph", async () => {
    const result = render(element({ view: "network" }));
    await screen.findByText(/표시 문헌 2/);
    const failure = Object.assign(new Error("Access revoked"), { code: "42501" });
    api.rpc.mockRejectedValueOnce(failure);
    fireEvent.click(screen.getByRole("button", { name: "보기 새로고침" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Access revoked");
    expect(props.onError).toHaveBeenCalledWith(failure);
    expect(result.container.querySelector(".project-network-node")).toBeNull();
  });
});

describe("literature views in the existing workspace", () => {
  const workspaceResponse = {
    workspace: {
      revision: 1,
      question: "Question",
      template: "general",
      columns: [{ id: "outcome", label: "결과", instruction: "" }],
    },
    can_edit: true,
  };
  const setupWorkspace = (writingTopics = []) => {
    api.rpc.mockImplementation(async (name) => {
      if (name === "research_workspace") return workspaceResponse;
      if (name === "research_references") return { items: references, total: references.length };
      if (name === "research_topics") return { items: writingTopics, total: writingTopics.length };
      if (name === "research_graph") return response;
      throw new Error(`Unexpected RPC ${name}`);
    });
    render(
      <MemoryRouter>
        <ResearchWorkspace project={{ id: 7, name: "Existing project" }} onClose={vi.fn()} />
      </MemoryRouter>,
    );
  };

  it("returns to the same table without losing an unsaved note", async () => {
    setupWorkspace(topics);
    fireEvent.click(await screen.findByRole("button", { name: "선행연구 표", exact: true }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prostate trial 설계 판단·메모" }), {
      target: { value: "Keep my unsaved note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "연결 지도", exact: true }));
    await screen.findByText(/표시 문헌 2/);
    const canvas = document.querySelector(".project-network-canvas");
    fireEvent.click(within(canvas).getByRole("button", { name: /본문 기반 요약 Prostate trial/ }));
    fireEvent.click(screen.getByRole("button", { name: "표에서 보기", exact: true }));
    expect(screen.getByRole("textbox", { name: "Prostate trial 설계 판단·메모" })).toHaveValue(
      "Keep my unsaved note",
    );
    expect(document.getElementById("research-reference-1")).toHaveFocus();
    expect(api.rpc.mock.calls.some(([name]) => name.startsWith("save_"))).toBe(false);
  });

  it("loads the existing writing entry with all linked references outside the bounded map", async () => {
    setupWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "선행연구 표", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "연결 지도", exact: true }));
    await screen.findByText(/표시 문헌 2/);
    const canvas = document.querySelector(".project-network-canvas");
    fireEvent.click(within(canvas).getByRole("button", { name: /집필 논점 Writing argument/ }));
    const fullTopic = {
      ...topics[0],
      reference_ids: [1, 999],
      references: [
        references[0],
        { id: 999, bibliography: { title: "Outside graph paper", pmid: "40000999" } },
      ],
    };
    api.rpc.mockImplementation(async (name) => {
      if (name === "research_topics") return { items: [fullTopic], total: 1 };
      if (name === "research_references") return { items: references, total: references.length };
      throw new Error(`Unexpected RPC ${name}`);
    });
    fireEvent.click(screen.getByRole("button", { name: "서론 논점에서 보기" }));
    expect(await screen.findByText("Outside graph paper", { exact: false })).toBeInTheDocument();
    expect(document.getElementById("research-topic-3")).toHaveFocus();
    expect(api.rpc).toHaveBeenCalledWith("research_topics", { p_id: 7, p_section: "all", p_page: 0 });
  });
});
