import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ResearchWorkspace from "./ResearchWorkspace";

const api = vi.hoisted(() => ({
  rpc: vi.fn(),
  download: vi.fn(),
  docx: vi.fn(),
  authorize: vi.fn(),
  google: false,
  user: { id: "reader-one" },
}));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: api.user }) }));
vi.mock("../lib/workspace", () => ({ rpc: api.rpc }));
vi.mock("../lib/googleDocsExport", () => ({
  googleDocsConfigured: () => api.google,
  prepareGoogleDocs: vi.fn().mockResolvedValue(true),
  authorizeGoogleExport: api.authorize,
  uploadGoogleDocument: vi.fn().mockResolvedValue({ url: "https://docs.google.com/document/d/test/edit" }),
}));
vi.mock("../lib/researchExport", () => ({
  adaptResearchWorkspaceExport: (value) => value,
  buildResearchCsv: (value) => JSON.stringify(value.references),
  buildResearchRis: () => "RIS",
  createResearchDocx: api.docx,
  downloadResearchExport: api.download,
  DOCX_MIME: "application/docx",
  getResearchExportCapabilities: () => ({ zoteroTransfer: false }),
}));

let workspace, references, topics, canEdit, record;
const copy = (value) => JSON.parse(JSON.stringify(value));
const project = { id: 7, name: "연구 준비" };
const renderWorkspace = () =>
  render(
    <MemoryRouter>
      <ResearchWorkspace project={project} onClose={vi.fn()} />
    </MemoryRouter>,
  );
const open = async (label) => {
  await screen.findByRole("button", { name: label, exact: true });
  fireEvent.click(screen.getByRole("button", { name: label, exact: true }));
};

beforeEach(() => {
  sessionStorage.clear();
  api.rpc.mockReset();
  api.download.mockReset();
  api.docx.mockReset();
  api.authorize.mockReset();
  api.google = false;
  api.user = { id: "reader-one" };
  api.docx.mockResolvedValue(new Blob(["docx"]));
  workspace = {
    collection_id: 7,
    revision: 2,
    question: "처음 질문",
    template: "general",
    columns: [
      { id: "population", label: "대상", instruction: "" },
      { id: "outcome", label: "결과", instruction: "" },
    ],
  };
  references = Array.from({ length: 26 }, (_, index) => ({
    id: index + 1,
    paper_id: index + 101,
    revision: 1,
    collection_id: 7,
    bibliography: {
      pmid: String(40000000 + index),
      title: `연구 ${index + 1}`,
      journal: "Journal",
      pub_date: "2025-01-01",
    },
    auto_values: { population: "자동 대상", outcome: "자동 결과" },
    user_values: {},
    note: "",
    tags: [],
    extraction_status: "complete",
  }));
  topics = [];
  canEdit = true;
  record = [];
  api.rpc.mockImplementation(async (name, args) => {
    if (name === "research_workspace") return { workspace: copy(workspace), can_edit: canEdit };
    if (name === "research_references")
      return {
        items: copy(references.slice(args.p_page * 20, args.p_page * 20 + 20)),
        total: references.length,
        page: args.p_page,
        can_edit: canEdit,
      };
    if (name === "research_topics") return { items: copy(topics), total: topics.length, page: 0 };
    if (name === "research_document_exports")
      return {
        items: record.slice(args.p_page * 20, args.p_page * 20 + 20),
        total: record.length,
        page: args.p_page,
      };
    if (name === "research_export_snapshot")
      return {
        project,
        workspace: copy(workspace),
        references: copy(references),
        topics: copy(topics),
        export_fingerprint: "a".repeat(64),
        revision_manifest: {
          references: references.map((item) => ({ id: item.id, revision: item.revision })),
          topics: [],
        },
      };
    if (name === "save_research_workspace") {
      if (args.p_expected_revision !== workspace.revision)
        throw Object.assign(new Error("conflict"), { code: "40001" });
      workspace = {
        ...workspace,
        question: args.p_question,
        template: args.p_template,
        columns: copy(args.p_columns),
        revision: workspace.revision + 1,
      };
      return copy(workspace);
    }
    if (name === "save_research_reference") {
      const index = references.findIndex((item) => item.id === args.p_id);
      if (args.p_expected_revision !== references[index].revision)
        throw Object.assign(new Error("conflict"), { code: "40001" });
      references[index] = {
        ...references[index],
        user_values: args.p_user_values,
        note: args.p_note,
        tags: args.p_tags,
        revision: references[index].revision + 1,
      };
      return copy(references[index]);
    }
    if (name === "request_research_extraction") return { status: "queued" };
    if (name === "save_research_topic") {
      const saved = {
        id: args.p_id || 90,
        revision: args.p_expected_revision + 1,
        section: args.p_section,
        title: args.p_title,
        body: args.p_body,
        reference_ids: args.p_reference_ids,
        cell_links: args.p_cell_links,
        references: references.filter((item) => args.p_reference_ids.includes(item.id)),
      };
      topics = [saved];
      return copy(saved);
    }
    if (name === "record_research_export") {
      record.push({
        export_id: args.p_export_id,
        format: args.p_format,
        workspace_revision: args.p_workspace_revision,
        reference_count: args.p_manifest.references.length,
        created_at: "2026-09-15T08:00:00Z",
      });
      return record[0];
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  sessionStorage.clear();
});

describe("project research workspace", () => {
  it("persists a configurable question and columns and reopens the saved version", async () => {
    const view = renderWorkspace();
    const question = await screen.findByRole("textbox", { name: "연구 질문", exact: true });
    fireEvent.change(question, { target: { value: "내 연구 질문" } });
    fireEvent.click(screen.getByRole("button", { name: "직접 항목 추가" }));
    fireEvent.change(screen.getByRole("textbox", { name: "항목 이름 3" }), {
      target: { value: "내 설계 변수" },
    });
    fireEvent.click(screen.getByRole("button", { name: "질문·항목 저장" }));
    await waitFor(() => expect(workspace.question).toBe("내 연구 질문"));
    await waitFor(() => expect(sessionStorage.getItem("uro-research-draft:reader-one:7")).toBeNull());
    view.unmount();
    renderWorkspace();
    expect(await screen.findByRole("textbox", { name: "연구 질문", exact: true })).toHaveValue(
      "내 연구 질문",
    );
    expect(screen.getByRole("textbox", { name: "항목 이름 3" })).toHaveValue("내 설계 변수");
  });

  it("keeps automatic extraction distinct from a deliberately empty manual override", async () => {
    renderWorkspace();
    await open("선행연구 표");
    const row = screen.getByRole("heading", { name: "연구 1", exact: true }).closest("tr");
    fireEvent.click(within(row).getByRole("checkbox", { name: "사용자 수정 · 결과" }));
    fireEvent.change(within(row).getByRole("textbox", { name: "연구 1 · 결과 수정값" }), {
      target: { value: "" },
    });
    fireEvent.change(within(row).getByRole("textbox", { name: "연구 1 설계 판단·메모" }), {
      target: { value: "비교군 조건을 다시 검토" },
    });
    fireEvent.click(within(row).getByRole("button", { name: "문헌 수정 저장" }));
    await waitFor(() => expect(references[0].user_values).toEqual({ outcome: "" }));
    expect(references[0].auto_values.outcome).toBe("자동 결과");
    expect(references[0].note).toBe("비교군 조건을 다시 검토");
    expect(within(row).getByText("자동 결과")).toBeVisible();
  });

  it("preserves local cell edits on CAS conflict until the user chooses the new revision", async () => {
    renderWorkspace();
    await open("선행연구 표");
    const row = screen.getByRole("heading", { name: "연구 1", exact: true }).closest("tr");
    fireEvent.change(within(row).getByRole("textbox", { name: "연구 1 설계 판단·메모" }), {
      target: { value: "내 미저장 판단" },
    });
    references[0].revision = 2;
    references[0].note = "공동 연구자 판단";
    fireEvent.click(within(row).getByRole("button", { name: "문헌 수정 저장" }));
    expect(await screen.findByRole("heading", { name: "동시 편집 확인" })).toBeVisible();
    expect(within(row).getByRole("textbox", { name: "연구 1 설계 판단·메모" })).toHaveValue("내 미저장 판단");
    expect(references[0].note).toBe("공동 연구자 판단");
    fireEvent.click(screen.getByRole("button", { name: "내 작성 내용으로 다시 저장" }));
    await waitFor(() => expect(references[0].note).toBe("내 미저장 판단"));
    const saves = api.rpc.mock.calls.filter(([name]) => name === "save_research_reference");
    expect(saves.map(([, args]) => args.p_expected_revision)).toEqual([1, 2]);
  });

  it("retains drafts after route unmount and keeps other accounts out of the restored draft", async () => {
    const view = renderWorkspace();
    fireEvent.change(await screen.findByRole("textbox", { name: "연구 질문", exact: true }), {
      target: { value: "임시 연구 질문" },
    });
    await waitFor(() =>
      expect(sessionStorage.getItem("uro-research-draft:reader-one:7")).toContain("임시 연구 질문"),
    );
    view.unmount();
    const restored = renderWorkspace();
    expect(await screen.findByRole("textbox", { name: "연구 질문", exact: true })).toHaveValue(
      "임시 연구 질문",
    );
    restored.unmount();
    api.user = { id: "reader-two" };
    renderWorkspace();
    expect(await screen.findByRole("textbox", { name: "연구 질문", exact: true })).toHaveValue("처음 질문");
  });

  it("exports the full snapshot beyond the current page and records only successful output", async () => {
    renderWorkspace();
    await open("연구 자료 내보내기");
    fireEvent.click(screen.getByRole("button", { name: "Word 문서 DOCX" }));
    await waitFor(() => expect(api.download).toHaveBeenCalled());
    expect(api.docx.mock.calls[0][0].references).toHaveLength(26);
    await waitFor(() => expect(record[0].reference_count).toBe(26));
    expect(screen.queryByRole("button", { name: "Zotero 전송용 DOCX" })).not.toBeInTheDocument();
    api.docx.mockRejectedValueOnce(new Error("export unavailable"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Word 문서 DOCX" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Word 문서 DOCX" }));
    await screen.findByText("export unavailable");
    expect(record).toHaveLength(1);
  });

  it("links a discussion topic to the same reference and extraction cell", async () => {
    renderWorkspace();
    await open("선행연구 표");
    const row = screen.getByRole("heading", { name: "연구 1", exact: true }).closest("tr");
    fireEvent.click(within(row).getAllByRole("button", { name: "이 항목을 논점에 연결" })[1]);
    fireEvent.change(screen.getByRole("combobox", { name: "문서 위치" }), {
      target: { value: "discussion" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "논점 제목" }), {
      target: { value: "결과 비교의 한계" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "주장·연결할 내용" }), {
      target: { value: "서로 다른 추적 기간을 구분한다." },
    });
    fireEvent.click(screen.getByRole("button", { name: "논점 저장" }));
    await waitFor(() => expect(topics).toHaveLength(1));
    expect(topics[0]).toMatchObject({
      section: "discussion",
      reference_ids: [1],
      cell_links: [{ reference_id: 1, column_id: "outcome" }],
    });
    expect(await screen.findByRole("heading", { name: "결과 비교의 한계" })).toBeVisible();
  });

  it("does not discard additional typing while a settings save is pending", async () => {
    const original = api.rpc.getMockImplementation();
    let finish;
    api.rpc.mockImplementation((name, args) =>
      name === "save_research_workspace"
        ? new Promise((resolve) => {
            finish = () => original(name, args).then(resolve);
          })
        : original(name, args),
    );
    renderWorkspace();
    const question = await screen.findByRole("textbox", { name: "연구 질문", exact: true });
    fireEvent.change(question, { target: { value: "저장 요청한 질문" } });
    fireEvent.click(screen.getByRole("button", { name: "질문·항목 저장" }));
    fireEvent.change(question, { target: { value: "기다리며 추가한 질문" } });
    await act(async () => {
      await finish();
    });
    expect(question).toHaveValue("기다리며 추가한 질문");
    expect(workspace.question).toBe("저장 요청한 질문");
    expect(screen.getByRole("button", { name: "질문·항목 저장" })).toBeEnabled();
  });

  it("keeps read-only users from editing or queueing extraction and can retry a failed initial load", async () => {
    canEdit = false;
    const original = api.rpc.getMockImplementation();
    let fail = true;
    api.rpc.mockImplementation((name, args) => {
      if (name === "research_workspace" && fail) return Promise.reject(new Error("일시적 연결 오류"));
      return original(name, args);
    });
    renderWorkspace();
    await screen.findByRole("alert");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "연구 자료 다시 불러오기" }));
    expect(await screen.findByRole("textbox", { name: "연구 질문", exact: true })).toBeDisabled();
    await open("선행연구 표");
    expect(screen.queryByRole("button", { name: "항목 추출 요청" })).not.toBeInTheDocument();
  });

  it("reports synchronous Google authorization failure without creating a document", async () => {
    api.google = true;
    api.authorize.mockImplementation(() => {
      throw new Error("연결 준비 중");
    });
    renderWorkspace();
    await open("연구 자료 내보내기");
    fireEvent.click(screen.getByRole("button", { name: "Google Docs로 보내기" }));
    expect(await screen.findByText("연결 준비 중")).toBeVisible();
    expect(api.docx).not.toHaveBeenCalled();
  });

  it("refreshes queued automatic values without replacing an unsaved manual cell", async () => {
    references[0].extraction_status = "queued";
    renderWorkspace();
    await open("선행연구 표");
    let row = screen.getByRole("heading", { name: "연구 1", exact: true }).closest("tr");
    fireEvent.click(within(row).getByRole("checkbox", { name: "사용자 수정 · 결과" }));
    fireEvent.change(within(row).getByRole("textbox", { name: "연구 1 · 결과 수정값" }), {
      target: { value: "직접 검토한 결과" },
    });
    vi.useFakeTimers();
    // Re-entering the table starts its bounded refresh timer under the controlled clock.
    fireEvent.click(screen.getByRole("button", { name: "연구 질문·추출 항목" }));
    fireEvent.click(screen.getByRole("button", { name: "선행연구 표" }));
    references[0].auto_values.outcome = "새 자동 추출값";
    row = screen.getByRole("heading", { name: "연구 1", exact: true }).closest("tr");
    references[0].extraction_status = "complete";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(within(row).getByText("새 자동 추출값")).toBeVisible();
    expect(within(row).getByRole("textbox", { name: "연구 1 · 결과 수정값" })).toHaveValue(
      "직접 검토한 결과",
    );
    const callCount = api.rpc.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000);
    });
    expect(api.rpc.mock.calls).toHaveLength(callCount);
  });

  it("clears displayed project data and its local draft when access is revoked", async () => {
    renderWorkspace();
    await open("선행연구 표");
    fireEvent.change(screen.getByRole("textbox", { name: "연구 1 설계 판단·메모" }), {
      target: { value: "개인 작성 중" },
    });
    await waitFor(() =>
      expect(sessionStorage.getItem("uro-research-draft:reader-one:7")).toContain("개인 작성 중"),
    );
    const original = api.rpc.getMockImplementation();
    api.rpc.mockImplementation((name, args) =>
      name === "research_references"
        ? Promise.reject(Object.assign(new Error("permission denied"), { code: "42501" }))
        : original(name, args),
    );
    fireEvent.click(screen.getByRole("button", { name: "추출 상태 새로고침" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("heading", { name: "연구 1", exact: true })).not.toBeInTheDocument();
    expect(sessionStorage.getItem("uro-research-draft:reader-one:7")).toBeNull();
  });

  it("retries a failed export receipt with the same ID without recreating the document", async () => {
    const original = api.rpc.getMockImplementation();
    let fail = true;
    api.rpc.mockImplementation((name, args) =>
      name === "record_research_export" && fail
        ? Promise.reject(new Error("network unavailable"))
        : original(name, args),
    );
    renderWorkspace();
    await open("연구 자료 내보내기");
    fireEvent.click(screen.getByRole("button", { name: "Word 문서 DOCX" }));
    await screen.findByRole("button", { name: "내보내기 기록 저장 재시도" });
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "내보내기 기록 저장 재시도" }));
    await waitFor(() => expect(record).toHaveLength(1));
    const attempts = api.rpc.mock.calls.filter(([name]) => name === "record_research_export");
    expect(attempts[0][1]).toEqual(attempts[1][1]);
    expect(api.docx).toHaveBeenCalledTimes(1);
    expect(api.download).toHaveBeenCalledTimes(1);
  });

  it("opens older personal export records beyond the first twenty", async () => {
    record = Array.from({ length: 25 }, (_, index) => ({
      export_id: String(index),
      format: "docx",
      workspace_revision: 2,
      reference_count: index + 1,
      created_at: "2026-09-15T08:00:00Z",
    }));
    renderWorkspace();
    await open("연구 자료 내보내기");
    fireEvent.click(await screen.findByRole("button", { name: "다음 내보내기 기록" }));
    await waitFor(() => expect(screen.getByText(/문헌 25편/)).toBeVisible());
    expect(screen.getByRole("button", { name: "다음 내보내기 기록" })).toBeDisabled();
    expect(api.rpc).toHaveBeenCalledWith("research_document_exports", { p_id: 7, p_page: 1 });
  });
});
