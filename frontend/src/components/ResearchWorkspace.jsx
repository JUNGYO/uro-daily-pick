import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { rpc } from "../lib/workspace";
import * as exports from "../lib/researchExport";
import ProjectLiteratureViews from "./ProjectLiteratureViews";
import {
  googleDocsConfigured,
  prepareGoogleDocs,
  authorizeGoogleExport,
  uploadGoogleDocument,
} from "../lib/googleDocsExport";
import "./researchWorkspace.css";

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const clone = (value) => JSON.parse(JSON.stringify(value));
const keyFor = (uid, id) => `uro-research-draft:${uid}:${id}`;
const revisionConflict = (error) => error?.code === "40001";
const accessDenied = (error) =>
  ["42501", "PGRST301", "PGRST302"].includes(error?.code) || [401, 403].includes(error?.status);
const pendingExtraction = (rows) =>
  rows.some((row) =>
    ["queued", "pending", "running", "processing", "retry", "waiting_source"].includes(row.extraction_status),
  );
const templates = {
  general: [
    ["study_design", "연구 설계"],
    ["population", "대상"],
    ["sample_size", "표본 수"],
    ["outcome", "주요 결과"],
    ["limitations", "한계"],
  ],
  intervention: [
    ["population", "대상"],
    ["intervention", "중재"],
    ["comparator", "비교군"],
    ["outcome", "평가변수와 결과"],
    ["follow_up", "추적 기간"],
    ["limitations", "한계"],
  ],
  diagnostic: [
    ["population", "대상"],
    ["index_test", "검사 방법"],
    ["reference_standard", "참조 표준"],
    ["diagnostic_accuracy", "진단 정확도"],
    ["limitations", "한계"],
  ],
  prognostic: [
    ["population", "대상"],
    ["predictors", "예측 변수"],
    ["validation", "검증 방법"],
    ["outcome", "결과"],
    ["follow_up", "추적 기간"],
    ["limitations", "한계"],
  ],
};
const templateLabels = {
  general: "일반 선행연구",
  intervention: "중재·치료 비교",
  diagnostic: "진단 연구",
  prognostic: "예후·예측 연구",
};
const statusLabels = {
  queued: "추출 대기",
  pending: "추출 대기",
  running: "추출 중",
  processing: "추출 중",
  complete: "추출 완료",
  completed: "추출 완료",
  ready: "추출 완료",
  failed: "추출 재시도 필요",
  waiting_source: "원문 준비 대기",
  stale: "기존 추출값 · 다시 추출 필요",
  retry: "추출 재시도 대기",
};
const emptyTopic = () => ({
  id: null,
  revision: 0,
  section: "introduction",
  title: "",
  body: "",
  reference_ids: [],
  cell_links: [],
});
const refDraft = (row) => ({
  revision: row.revision,
  user_values: clone(row.user_values || {}),
  note: row.note || "",
  tags: (row.tags || []).join(", "),
});
const settingsDraft = (workspace) => ({
  revision: workspace.revision,
  question: workspace.question || "",
  template: workspace.template || "general",
  columns: clone(workspace.columns || []),
});

export default function ResearchWorkspace({ project, onClose }) {
  const { user } = useAuth();
  const [data, setData] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [loadRevision, setLoadRevision] = useState(0),
    [loadedFor, setLoadedFor] = useState("");
  const [settings, setSettings] = useState(null),
    [rows, setRows] = useState([]),
    [total, setTotal] = useState(0);
  const [page, setPage] = useState(0),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("");
  const [drafts, setDrafts] = useState({}),
    [topics, setTopics] = useState([]),
    [topicTotal, setTopicTotal] = useState(0),
    [topicPage, setTopicPage] = useState(0);
  const [topic, setTopic] = useState(null),
    [tab, setTab] = useState("question"),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(null),
    [closeCheck, setCloseCheck] = useState(false),
    [history, setHistory] = useState([]),
    [documentUrl, setDocumentUrl] = useState("");
  const [historyPage, setHistoryPage] = useState(0),
    [historyTotal, setHistoryTotal] = useState(0),
    [pendingReceipt, setPendingReceipt] = useState(null);
  const [linksQuery, setLinksQuery] = useState(""),
    [linkRows, setLinkRows] = useState([]),
    [linkPage, setLinkPage] = useState(0),
    [linkTotal, setLinkTotal] = useState(0);
  const [literatureView, setLiteratureView] = useState("table"),
    [literatureTarget, setLiteratureTarget] = useState(null);
  const current = useRef({}),
    focusedLiteratureTarget = useRef(null),
    saveLock = useRef(false),
    mounted = useRef(false),
    generation = useRef(0);
  const canEdit = !!data?.can_edit && !user?.offline;
  const settingsChanged =
    !!settings && !!data && JSON.stringify(settings) !== JSON.stringify(settingsDraft(data.workspace));
  const dirty = settingsChanged || Object.keys(drafts).length > 0 || !!topic;
  current.current = { settings, drafts, topic, dirty };

  useEffect(() => {
    if (!literatureTarget || focusedLiteratureTarget.current === literatureTarget) return;
    const id = literatureTarget.topicId
      ? `research-topic-${literatureTarget.topicId}`
      : literatureTarget.columnId
        ? `research-cell-${literatureTarget.referenceId}-${literatureTarget.columnId}`
        : `research-reference-${literatureTarget.referenceId}`;
    const target = document.getElementById(id);
    if (!target || (tab === "table" && literatureView !== "table")) return;
    target.scrollIntoView?.({ block: "nearest" });
    target.focus({ preventScroll: true });
    focusedLiteratureTarget.current = literatureTarget;
  }, [literatureTarget, literatureView, tab, rows, topics]);

  function reportError(err) {
    if (accessDenied(err)) {
      generation.current += 1;
      setData(null);
      setSettings(null);
      setRows([]);
      setTopics([]);
      setDrafts({});
      setTopic(null);
      setHistory([]);
      setDocumentUrl("");
      setPendingReceipt(null);
      setConflict(null);
      setLoadedFor("");
      try {
        sessionStorage.removeItem(keyFor(user?.id, project.id));
      } catch {
        /* Storage may be unavailable. */
      }
      setError("프로젝트 접근 권한을 확인할 수 없습니다. 다시 불러오거나 프로젝트로 돌아가 주세요.");
    } else setNotice(err.message || "작업을 완료하지 못했습니다. 작성 내용은 유지됩니다.");
  }

  useEffect(() => {
    let alive = true;
    mounted.current = true;
    const serial = ++generation.current;
    setLoading(true);
    setError("");
    setData(null);
    setSettings(null);
    setDrafts({});
    setTopic(null);
    setBusy("");
    setHistory([]);
    setHistoryPage(0);
    setHistoryTotal(0);
    setDocumentUrl("");
    setPendingReceipt(null);
    Promise.all([
      rpc("research_workspace", { p_id: project.id }),
      rpc("research_references", { p_id: project.id, p_query: "", p_page: 0 }),
      rpc("research_topics", { p_id: project.id, p_section: "all", p_page: 0 }),
    ])
      .then(([workspace, references, sections]) => {
        if (!alive) return;
        setData(workspace);
        setLoadedFor(`${user.id}:${project.id}`);
        setSettings(settingsDraft(workspace.workspace));
        setRows(references.items);
        setTotal(references.total);
        setTopics(sections.items);
        setTopicTotal(sections.total);
        try {
          const stored = JSON.parse(sessionStorage.getItem(keyFor(user.id, project.id)) || "null");
          if (workspace.can_edit && stored) {
            if (stored.settings) setSettings(stored.settings);
            setDrafts(stored.drafts || {});
            setTopic(stored.topic || null);
            setNotice("이 탭에 남아 있던 작성 내용을 복원했습니다. 저장할 때 최신 버전을 확인합니다.");
          }
        } catch {
          /* Invalid or unavailable draft storage must not block the server workspace. */
        }
      })
      .catch((err) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    if (googleDocsConfigured()) Promise.resolve(prepareGoogleDocs()).catch(() => {});
    return () => {
      alive = false;
      mounted.current = false;
      if (generation.current === serial) generation.current += 1;
    };
  }, [project.id, user?.id, loadRevision]);

  useEffect(() => {
    if (!data || !user?.id || loadedFor !== `${user.id}:${project.id}`) return;
    try {
      const key = keyFor(user.id, project.id);
      if (dirty && canEdit)
        sessionStorage.setItem(
          key,
          JSON.stringify({ settings: settingsChanged ? settings : null, drafts, topic }),
        );
      else sessionStorage.removeItem(key);
    } catch {
      setNotice("이 탭에 임시 저장할 수 없습니다. 화면을 나가기 전에 서버에 저장해 주세요.");
    }
  }, [settings, drafts, topic, dirty, settingsChanged, canEdit, data, project.id, user?.id, loadedFor]);

  useEffect(() => {
    const handler = (event) => {
      if (current.current.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  useEffect(() => {
    if (!data) return;
    let alive = true;
    rpc("research_references", { p_id: project.id, p_query: filter, p_page: page })
      .then((result) => {
        if (alive) {
          setRows(result.items);
          setTotal(result.total);
        }
      })
      .catch((err) => {
        if (alive) reportError(err);
      });
    return () => {
      alive = false;
    };
  }, [project.id, filter, page, !!data]);

  useEffect(() => {
    if (!data) return;
    let alive = true;
    rpc("research_topics", { p_id: project.id, p_section: "all", p_page: topicPage })
      .then((result) => {
        if (alive) {
          setTopics(result.items);
          setTopicTotal(result.total);
        }
      })
      .catch((err) => {
        if (alive) reportError(err);
      });
    return () => {
      alive = false;
    };
  }, [project.id, topicPage, !!data]);

  useEffect(() => {
    if (!topic) return;
    let alive = true;
    const timer = setTimeout(
      () =>
        rpc("research_references", { p_id: project.id, p_query: linksQuery, p_page: linkPage })
          .then((result) => {
            if (alive) {
              setLinkRows(result.items);
              setLinkTotal(result.total);
            }
          })
          .catch((err) => {
            if (alive) reportError(err);
          }),
      180,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [project.id, linksQuery, linkPage, !!topic]);

  useEffect(() => {
    if (!data || tab !== "table") return;
    let alive = true,
      timer,
      delay = 15000;
    const schedule = () => {
      timer = setTimeout(poll, delay);
    };
    async function poll() {
      if (!alive) return;
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      try {
        const result = await rpc("research_references", { p_id: project.id, p_query: filter, p_page: page });
        if (!alive) return;
        setRows(result.items);
        setTotal(result.total);
        if (pendingExtraction(result.items)) {
          delay = Math.min(delay * 1.5, 60000);
          schedule();
        }
      } catch (err) {
        if (!alive) return;
        reportError(err);
        if (!accessDenied(err)) {
          delay = Math.min(delay * 2, 60000);
          schedule();
        }
      }
    }
    if (pendingExtraction(rows)) schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [project.id, tab, filter, page, !!data, pendingExtraction(rows)]);

  useEffect(() => {
    if (!data || tab !== "export") return;
    let alive = true;
    refreshHistory(() => alive, historyPage).catch((err) => {
      if (alive) reportError(err);
    });
    return () => {
      alive = false;
    };
  }, [project.id, tab, historyPage, !!data]);

  async function run(name, action) {
    if (saveLock.current) return;
    saveLock.current = true;
    setBusy(name);
    setNotice("");
    const serial = generation.current;
    try {
      await action(() => mounted.current && serial === generation.current);
    } catch (err) {
      if (mounted.current && serial === generation.current) reportError(err);
    } finally {
      saveLock.current = false;
      if (mounted.current && serial === generation.current) setBusy("");
    }
  }
  function changeRow(row, patch) {
    setDrafts((before) => ({ ...before, [row.id]: { ...(before[row.id] || refDraft(row)), ...patch } }));
  }
  async function saveSettings(isCurrent, expected = settings.revision) {
    const submitted = clone(current.current.settings);
    try {
      const saved = await rpc("save_research_workspace", {
        p_id: project.id,
        p_expected_revision: expected,
        p_question: submitted.question,
        p_template: submitted.template,
        p_columns: submitted.columns,
      });
      if (!isCurrent()) return;
      setData((before) => ({ ...before, workspace: saved }));
      setSettings((before) =>
        JSON.stringify(before) === JSON.stringify(submitted)
          ? settingsDraft(saved)
          : { ...before, revision: saved.revision },
      );
      setConflict(null);
      setNotice("연구 질문과 추출 항목을 저장했습니다.");
    } catch (err) {
      if (!revisionConflict(err)) throw err;
      const latest = await rpc("research_workspace", { p_id: project.id });
      if (isCurrent()) {
        setConflict({ kind: "settings", latest: latest.workspace });
        setNotice("다른 편집 내용이 먼저 저장됐습니다. 내 작성 내용은 유지됩니다.");
      }
    }
  }
  async function saveRow(row, isCurrent, expected) {
    const submitted = clone(current.current.drafts[row.id] || refDraft(row));
    try {
      const saved = await rpc("save_research_reference", {
        p_id: row.id,
        p_expected_revision: expected ?? submitted.revision,
        p_user_values: submitted.user_values,
        p_note: submitted.note,
        p_tags: submitted.tags
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 20),
      });
      if (!isCurrent()) return;
      setRows((before) => before.map((item) => (item.id === saved.id ? saved : item)));
      setDrafts((before) => {
        const next = { ...before };
        if (JSON.stringify(before[row.id]) === JSON.stringify(submitted)) delete next[row.id];
        else if (next[row.id]) next[row.id] = { ...next[row.id], revision: saved.revision };
        return next;
      });
      setConflict(null);
      setNotice("문헌의 수정값과 설계 판단을 저장했습니다.");
    } catch (err) {
      if (!revisionConflict(err)) throw err;
      const snapshot = await rpc("research_export_snapshot", { p_id: project.id });
      const latest = snapshot.references.find((item) => item.id === row.id);
      if (isCurrent()) {
        setConflict({ kind: "row", row, latest });
        setNotice("이 문헌이 갱신됐습니다. 내 수정값은 유지됩니다.");
      }
    }
  }
  async function saveTopic(isCurrent, expected = topic.revision) {
    const submitted = clone(current.current.topic);
    try {
      const saved = await rpc("save_research_topic", {
        p_collection_id: project.id,
        p_id: submitted.id,
        p_expected_revision: expected,
        p_section: submitted.section,
        p_title: submitted.title,
        p_body: submitted.body,
        p_reference_ids: submitted.reference_ids,
        p_cell_links: submitted.cell_links || [],
      });
      if (!isCurrent()) return;
      setTopic((before) =>
        JSON.stringify(before) === JSON.stringify(submitted)
          ? null
          : before
            ? { ...before, id: saved.id, revision: saved.revision }
            : null,
      );
      const result = await rpc("research_topics", { p_id: project.id, p_section: "all", p_page: topicPage });
      if (isCurrent()) {
        setTopics(result.items);
        setTopicTotal(result.total);
        setConflict(null);
        setNotice("논점과 연결 근거를 저장했습니다.");
      }
    } catch (err) {
      if (!revisionConflict(err)) throw err;
      const snapshot = await rpc("research_export_snapshot", { p_id: project.id });
      if (isCurrent()) {
        setConflict({ kind: "topic", latest: snapshot.topics.find((item) => item.id === submitted.id) });
        setNotice("논점이 먼저 변경됐습니다. 내 작성 내용은 유지됩니다.");
      }
    }
  }
  async function refreshRows(isCurrent) {
    const result = await rpc("research_references", { p_id: project.id, p_query: filter, p_page: page });
    if (isCurrent()) {
      setRows(result.items);
      setTotal(result.total);
    }
  }
  async function refreshHistory(isCurrent, requestedPage = historyPage) {
    const result = await rpc("research_document_exports", { p_id: project.id, p_page: requestedPage });
    if (isCurrent()) {
      setHistory(result.items);
      setHistoryTotal(result.total);
    }
  }
  function startExport(format) {
    if (saveLock.current) return;
    if (dirty) {
      setNotice(
        "작성 중인 질문·수정값·논점을 먼저 저장해 주세요. 내보내기는 서버에 저장한 버전으로 생성합니다.",
      );
      return;
    }
    let authorization;
    try {
      authorization = format === "google_docs" ? authorizeGoogleExport() : null;
    } catch (err) {
      setNotice(err.message);
      Promise.resolve(prepareGoogleDocs()).catch(() => {});
      return;
    }
    return run("export", async (isCurrent) => {
      const token = authorization ? await authorization : null;
      if (!isCurrent()) return;
      const snapshot = await rpc("research_export_snapshot", { p_id: project.id });
      if (!isCurrent()) return;
      const input = exports.adaptResearchWorkspaceExport(snapshot),
        exportId = crypto.randomUUID();
      const title = `${project.name} 연구 자료`,
        filename = title.replace(/[\\/:*?"<>|]/g, "_");
      let url = null;
      if (format === "csv")
        exports.downloadResearchExport(
          filename + ".csv",
          exports.buildResearchCsv(input),
          "text/csv;charset=utf-8",
        );
      else if (format === "ris")
        exports.downloadResearchExport(
          filename + ".ris",
          exports.buildResearchRis(input),
          "application/x-research-info-systems",
        );
      else {
        const blob =
          format === "zotero"
            ? await exports.createZoteroTransferDocx(input)
            : await exports.createResearchDocx(input);
        if (!isCurrent()) return;
        if (format === "google_docs") {
          const result = await uploadGoogleDocument({ token, blob, title, exportId });
          url = result.url;
          if (isCurrent()) setDocumentUrl(url);
        } else exports.downloadResearchExport(filename + ".docx", blob, exports.DOCX_MIME);
      }
      const receipt = {
        p_id: project.id,
        p_export_id: exportId,
        p_format: format === "zotero" ? "docx" : format,
        p_workspace_revision: snapshot.workspace.revision,
        p_fingerprint: snapshot.export_fingerprint,
        p_manifest: snapshot.revision_manifest,
        p_url: url,
      };
      try {
        await rpc("record_research_export", receipt);
        if (isCurrent()) {
          setPendingReceipt(null);
          setHistoryPage(0);
          setNotice("저장된 프로젝트 전체 자료를 내보냈습니다.");
          await refreshHistory(isCurrent, 0);
        }
      } catch (err) {
        if (isCurrent() && accessDenied(err)) reportError(err);
        else if (isCurrent()) {
          setPendingReceipt(receipt);
          setNotice(
            "문서는 생성했지만 프로젝트의 내보내기 기록을 저장하지 못했습니다. 생성된 문서는 다시 만들 필요가 없습니다.",
          );
        }
      }
    });
  }
  const referenceMap = Object.fromEntries(
    [...rows, ...linkRows, ...topics.flatMap((item) => item.references || [])].map((item) => [item.id, item]),
  );
  const linkPaper = (row) =>
    row?.bibliography?.pmid ? (
      <Link to={`/papers/${row.bibliography.pmid}?tab=study`} target="_blank" rel="noreferrer">
        논문·근거 열기 ↗
      </Link>
    ) : null;
  const addTopicFromCell = (row, column) => {
    if (topic) {
      setNotice("작성 중인 논점을 저장하거나 취소한 뒤 새 논점을 만들어 주세요.");
      setTab("writing");
      return;
    }
    setTopic({
      ...emptyTopic(),
      reference_ids: [row.id],
      cell_links: column ? [{ reference_id: row.id, column_id: column.id }] : [],
    });
    setTab("writing");
  };

  const showLiteratureReference = (row, columnId) => {
    if (!rows.some((candidate) => candidate.id === row.id)) {
      const search = row.bibliography?.pmid || row.paper?.pmid || row.bibliography?.title || "";
      setQuery(search);
      setFilter(search);
      setPage(0);
    }
    setLiteratureTarget({ referenceId: row.id, columnId });
    setLiteratureView("table");
    setTab("table");
  };
  const showLiteratureTopic = (selectedTopic) => {
    // Keep unsaved writing intact while opening the existing saved argument.
    if (!topics.some((item) => item.id === selectedTopic.id)) {
      // The bounded graph uses the same first twenty topics as the writing RPC.
      setTopicPage(0);
      if (topicPage === 0) {
        run("topic-open", async (isCurrent) => {
          const result = await rpc("research_topics", { p_id: project.id, p_section: "all", p_page: 0 });
          if (isCurrent()) {
            setTopics(result.items);
            setTopicTotal(result.total);
          }
        });
      }
    }
    setLiteratureTarget({ topicId: selectedTopic.id });
    setTab("writing");
  };

  if (error)
    return (
      <section className="research-workspace">
        <p role="alert">{error}</p>
        <button className="btn-primary" onClick={() => setLoadRevision((value) => value + 1)}>
          연구 자료 다시 불러오기
        </button>
        <button className="btn-secondary" onClick={onClose}>
          프로젝트로 돌아가기
        </button>
      </section>
    );
  if (loading || loadedFor !== `${user?.id}:${project.id}`)
    return (
      <section className="research-workspace" aria-label="연구 설계·집필 자료">
        <p role="status">연구 자료를 불러오는 중…</p>
      </section>
    );
  if (!data || !settings) return null;
  return (
    <section className="research-workspace" aria-label="연구 설계·집필 자료">
      <header className="research-heading">
        <div>
          <h2>연구 설계·집필 자료</h2>
          <p>
            {project.name} · {canEdit ? "공동 편집" : "읽기 전용"}
          </p>
        </div>
        <button className="btn-secondary" onClick={() => (dirty ? setCloseCheck(true) : onClose())}>
          프로젝트로 돌아가기
        </button>
      </header>
      {closeCheck && (
        <div className="reader-notice">
          <p>서버에 저장하지 않은 작성 내용이 있습니다. 이 탭에 임시 보관한 뒤 닫을 수 있습니다.</p>
          <button className="btn-secondary" onClick={() => setCloseCheck(false)}>
            계속 작성
          </button>
          <button className="btn-secondary" onClick={onClose}>
            임시 보관하고 닫기
          </button>
        </div>
      )}
      <div className="research-tabs" aria-label="연구 자료 보기">
        {[
          ["question", "연구 질문·추출 항목"],
          ["table", "선행연구 표"],
          ["writing", "서론·고찰 논점"],
          ["export", "연구 자료 내보내기"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "btn-primary" : "btn-secondary"}
            aria-pressed={tab === id}
            onClick={() => {
              setTab(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p role="status" className="research-message">
        {notice}
      </p>
      {conflict && (
        <div role="alert" className="reader-notice research-conflict">
          <h3>동시 편집 확인</h3>
          <p>최신 서버 값과 내 작성 내용을 비교한 뒤 선택하세요. 자동으로 덮어쓰지 않습니다.</p>
          <pre>
            {JSON.stringify(
              conflict.latest
                ? conflict.kind === "settings"
                  ? { question: conflict.latest.question, columns: conflict.latest.columns }
                  : conflict.kind === "row"
                    ? { user_values: conflict.latest.user_values, note: conflict.latest.note }
                    : { title: conflict.latest.title, body: conflict.latest.body }
                : "대상이 더 이상 없습니다.",
              null,
              2,
            )}
          </pre>
          {conflict.latest && (
            <div className="reader-actions">
              <button
                className="btn-secondary"
                disabled={!!busy}
                onClick={() => {
                  if (conflict.kind === "settings") {
                    setData((before) => ({ ...before, workspace: conflict.latest }));
                    setSettings(settingsDraft(conflict.latest));
                  } else if (conflict.kind === "row") {
                    setRows((before) =>
                      before.map((row) => (row.id === conflict.latest.id ? conflict.latest : row)),
                    );
                    setDrafts((before) => {
                      const next = { ...before };
                      delete next[conflict.row.id];
                      return next;
                    });
                  } else setTopic(clone(conflict.latest));
                  setConflict(null);
                }}
              >
                서버 값 사용
              </button>
              <button
                className="btn-primary"
                disabled={!!busy || !canEdit}
                onClick={() =>
                  run("conflict", (isCurrent) =>
                    conflict.kind === "settings"
                      ? saveSettings(isCurrent, conflict.latest.revision)
                      : conflict.kind === "row"
                        ? saveRow(conflict.row, isCurrent, conflict.latest.revision)
                        : saveTopic(isCurrent, conflict.latest.revision),
                  )
                }
              >
                내 작성 내용으로 다시 저장
              </button>
            </div>
          )}
        </div>
      )}

      {tab === "question" && (
        <div className="research-question">
          <label>
            연구 질문
            <textarea
              value={settings.question}
              maxLength={4000}
              disabled={!canEdit}
              onChange={(event) => setSettings((before) => ({ ...before, question: event.target.value }))}
              placeholder="어떤 대상에서 무엇을 비교하고 어떤 결과를 확인할까요?"
            />
          </label>
          <div className="reader-actions">
            <label>
              추출 항목 템플릿
              <select
                disabled={!canEdit}
                value={settings.template}
                onChange={(event) => setSettings((before) => ({ ...before, template: event.target.value }))}
              >
                {Object.entries(templateLabels).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn-secondary"
              disabled={!canEdit}
              onClick={() =>
                setSettings((before) => ({
                  ...before,
                  columns: [
                    ...before.columns,
                    ...(templates[before.template] || templates.general)
                      .filter(([id]) => !before.columns.some((column) => column.id === id))
                      .map(([id, label]) => ({ id, label, instruction: "" })),
                  ].slice(0, 30),
                }))
              }
            >
              템플릿 항목 추가
            </button>
          </div>
          <p className="reader-muted">
            기존 항목과 수정값은 유지됩니다. 항목을 숨겨도 문헌에 저장한 수정값은 남습니다.
          </p>
          <div className="research-columns">
            {settings.columns.map((column, index) => (
              <div className="research-column" key={column.id}>
                <label>
                  항목 이름 {index + 1}
                  <input
                    value={column.label}
                    disabled={!canEdit}
                    maxLength={100}
                    onChange={(event) =>
                      setSettings((before) => ({
                        ...before,
                        columns: before.columns.map((item) =>
                          item.id === column.id ? { ...item, label: event.target.value } : item,
                        ),
                      }))
                    }
                  />
                </label>
                <label>
                  추출 지침 {index + 1}
                  <input
                    value={column.instruction || ""}
                    disabled={!canEdit}
                    maxLength={300}
                    placeholder="결과의 단위와 시점 등"
                    onChange={(event) =>
                      setSettings((before) => ({
                        ...before,
                        columns: before.columns.map((item) =>
                          item.id === column.id ? { ...item, instruction: event.target.value } : item,
                        ),
                      }))
                    }
                  />
                </label>
                <button
                  className="btn-secondary"
                  aria-label={`${column.label} 항목 숨기기`}
                  disabled={!canEdit || settings.columns.length <= 1}
                  onClick={() =>
                    setSettings((before) => ({
                      ...before,
                      columns: before.columns.filter((item) => item.id !== column.id),
                    }))
                  }
                >
                  숨기기
                </button>
              </div>
            ))}
          </div>
          <div className="reader-actions">
            <button
              className="btn-secondary"
              disabled={!canEdit || settings.columns.length >= 30}
              onClick={() =>
                setSettings((before) => ({
                  ...before,
                  columns: [
                    ...before.columns,
                    {
                      id: "custom_" + crypto.randomUUID().replaceAll("-", "").slice(0, 24),
                      label: "새 항목",
                      instruction: "",
                    },
                  ],
                }))
              }
            >
              직접 항목 추가
            </button>
            <button
              className="btn-primary"
              disabled={
                !canEdit ||
                !!busy ||
                !settingsChanged ||
                settings.columns.some((column) => !column.label.trim())
              }
              onClick={() => run("settings", saveSettings)}
            >
              질문·항목 저장
            </button>
          </div>
        </div>
      )}

      {tab === "table" && (
        <>
          <form
            className="research-filter"
            onSubmit={(event) => {
              event.preventDefault();
              setFilter(query.trim());
              setPage(0);
            }}
          >
            <label>
              프로젝트 문헌 검색
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                maxLength={200}
                placeholder="제목·메모·태그"
              />
            </label>
            <button className="btn-secondary">검색</button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!!busy}
              onClick={() => run("refresh", refreshRows)}
            >
              추출 상태 새로고침
            </button>
          </form>
          <p>
            프로젝트 문헌 {total}편 · {page + 1}페이지
          </p>
          {!rows.length && <p>문헌 상세의 메모·보관에서 이 프로젝트에 문헌을 추가해 주세요.</p>}
          <ProjectLiteratureViews
            key={project.id}
            projectId={project.id}
            filter={filter}
            view={literatureView}
            onViewChange={setLiteratureView}
            columns={settings.columns}
            onShowReference={showLiteratureReference}
            onShowTopic={showLiteratureTopic}
            onError={reportError}
          />
          <div className="project-literature-table" hidden={literatureView !== "table"}>
            <div className="research-table-scroll">
              <table className="research-table">
                <thead>
                  <tr>
                    <th>문헌</th>
                    {settings.columns.map((column) => (
                      <th key={column.id}>{column.label}</th>
                    ))}
                    <th>연구 설계 판단·메모</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const draft = drafts[row.id] || refDraft(row);
                    return (
                      <tr
                        key={row.id}
                        id={`research-reference-${row.id}`}
                        tabIndex={-1}
                        className={
                          literatureTarget?.referenceId === row.id && !literatureTarget?.columnId
                            ? "project-literature-target"
                            : undefined
                        }
                      >
                        <th scope="row" data-label="문헌">
                          <h3>{row.bibliography?.title || "제목 미등록"}</h3>
                          <p>
                            {row.bibliography?.journal} · {row.bibliography?.pub_date}
                          </p>
                          {linkPaper(row)}
                          <p className="reader-muted">{statusLabels[row.extraction_status] || "추출 전"}</p>
                          {canEdit && (
                            <button
                              className="btn-secondary"
                              disabled={!!busy || settingsChanged}
                              onClick={() =>
                                run("extract", async (isCurrent) => {
                                  await rpc("request_research_extraction", { p_id: row.id });
                                  await refreshRows(isCurrent);
                                  if (isCurrent())
                                    setNotice("추출을 요청했습니다. 사용자 수정값은 유지됩니다.");
                                })
                              }
                            >
                              항목 추출 요청
                            </button>
                          )}
                        </th>
                        {settings.columns.map((column) => {
                          const manual = own(draft.user_values, column.id);
                          return (
                            <td
                              data-label={column.label}
                              key={column.id}
                              id={`research-cell-${row.id}-${column.id}`}
                              tabIndex={-1}
                              className={
                                literatureTarget?.referenceId === row.id &&
                                literatureTarget?.columnId === column.id
                                  ? "project-literature-target"
                                  : undefined
                              }
                            >
                              <p className="research-auto-label">자동 추출</p>
                              <p className="research-auto-value">
                                {row.auto_values?.[column.id] ||
                                  (row.extraction_status === "waiting_source"
                                    ? "원문 준비 대기"
                                    : "아직 추출된 값 없음")}
                              </p>
                              <label className="research-override">
                                <input
                                  type="checkbox"
                                  checked={manual}
                                  disabled={!canEdit}
                                  onChange={(event) => {
                                    const values = { ...draft.user_values };
                                    if (event.target.checked)
                                      values[column.id] = row.auto_values?.[column.id] || "";
                                    else delete values[column.id];
                                    changeRow(row, { user_values: values });
                                  }}
                                />
                                사용자 수정 · {column.label}
                              </label>
                              {manual && (
                                <textarea
                                  aria-label={`${row.bibliography?.title} · ${column.label} 수정값`}
                                  value={draft.user_values[column.id]}
                                  maxLength={1500}
                                  disabled={!canEdit}
                                  onChange={(event) =>
                                    changeRow(row, {
                                      user_values: { ...draft.user_values, [column.id]: event.target.value },
                                    })
                                  }
                                />
                              )}
                              {canEdit && (
                                <button
                                  className="research-text-button"
                                  onClick={() => addTopicFromCell(row, column)}
                                >
                                  이 항목을 논점에 연결
                                </button>
                              )}
                            </td>
                          );
                        })}
                        <td data-label="연구 설계 판단·메모">
                          <label>
                            설계 판단·메모
                            <textarea
                              aria-label={`${row.bibliography?.title} 설계 판단·메모`}
                              value={draft.note}
                              maxLength={6000}
                              disabled={!canEdit}
                              onChange={(event) => changeRow(row, { note: event.target.value })}
                            />
                          </label>
                          <label>
                            태그
                            <input
                              aria-label={`${row.bibliography?.title} 태그`}
                              value={draft.tags}
                              maxLength={2000}
                              disabled={!canEdit}
                              onChange={(event) => changeRow(row, { tags: event.target.value })}
                              placeholder="쉼표로 구분"
                            />
                          </label>
                          <button
                            className="btn-primary"
                            disabled={!canEdit || !!busy || !drafts[row.id]}
                            onClick={() => run("row", (isCurrent) => saveRow(row, isCurrent))}
                          >
                            문헌 수정 저장
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="reader-actions">
              <button
                className="btn-secondary"
                disabled={!page}
                onClick={() => setPage((value) => value - 1)}
              >
                이전 문헌
              </button>
              <button
                className="btn-secondary"
                disabled={(page + 1) * 20 >= total}
                onClick={() => setPage((value) => value + 1)}
              >
                다음 문헌
              </button>
            </div>
          </div>
        </>
      )}

      {tab === "writing" && (
        <>
          <p>선행연구 표와 같은 문헌·추출 항목을 서론과 고찰의 논점에 연결합니다.</p>
          <button
            className="btn-secondary"
            disabled={!canEdit || !!topic}
            onClick={() => setTopic(emptyTopic())}
          >
            논점 추가
          </button>
          {topic && (
            <form
              className="research-topic-editor"
              onSubmit={(event) => {
                event.preventDefault();
                run("topic", saveTopic);
              }}
            >
              <label>
                문서 위치
                <select
                  disabled={!canEdit}
                  value={topic.section}
                  onChange={(event) => setTopic((before) => ({ ...before, section: event.target.value }))}
                >
                  <option value="introduction">서론</option>
                  <option value="discussion">고찰</option>
                </select>
              </label>
              <label>
                논점 제목
                <input
                  required
                  maxLength={200}
                  disabled={!canEdit}
                  value={topic.title}
                  onChange={(event) => setTopic((before) => ({ ...before, title: event.target.value }))}
                />
              </label>
              <label>
                주장·연결할 내용
                <textarea
                  maxLength={12000}
                  disabled={!canEdit}
                  value={topic.body}
                  onChange={(event) => setTopic((before) => ({ ...before, body: event.target.value }))}
                />
              </label>
              <fieldset>
                <legend>연결 문헌 {topic.reference_ids.length}편</legend>
                {topic.reference_ids.map((id) => (
                  <div className="research-linked-reference" key={id}>
                    <span>{referenceMap[id]?.bibliography?.title || `연결 문헌 ${id}`}</span>
                    <button
                      type="button"
                      className="research-text-button"
                      disabled={!canEdit}
                      onClick={() =>
                        setTopic((before) => ({
                          ...before,
                          reference_ids: before.reference_ids.filter((value) => value !== id),
                          cell_links: (before.cell_links || []).filter((cell) => cell.reference_id !== id),
                        }))
                      }
                    >
                      연결 해제
                    </button>
                    <label>
                      연결할 추출 항목
                      <select
                        aria-label={`${referenceMap[id]?.bibliography?.title || id} 근거 항목`}
                        value=""
                        onChange={(event) => {
                          if (!event.target.value) return;
                          const columnId = event.target.value;
                          setTopic((before) => ({
                            ...before,
                            cell_links: [
                              ...(before.cell_links || []).filter(
                                (cell) => !(cell.reference_id === id && cell.column_id === columnId),
                              ),
                              { reference_id: id, column_id: columnId },
                            ].slice(0, 100),
                          }));
                        }}
                      >
                        <option value="">항목 선택</option>
                        {settings.columns.map((column) => (
                          <option key={column.id} value={column.id}>
                            {column.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {(topic.cell_links || [])
                      .filter((cell) => cell.reference_id === id)
                      .map((cell) => (
                        <button
                          key={cell.column_id}
                          type="button"
                          className="research-chip"
                          onClick={() =>
                            setTopic((before) => ({
                              ...before,
                              cell_links: before.cell_links.filter(
                                (item) => !(item.reference_id === id && item.column_id === cell.column_id),
                              ),
                            }))
                          }
                        >
                          {settings.columns.find((column) => column.id === cell.column_id)?.label ||
                            cell.column_id}{" "}
                          · 해제
                        </button>
                      ))}
                  </div>
                ))}
                <label>
                  연결할 문헌 검색
                  <input
                    value={linksQuery}
                    maxLength={200}
                    onChange={(event) => {
                      setLinksQuery(event.target.value);
                      setLinkPage(0);
                    }}
                  />
                </label>
                {linkRows
                  .filter((row) => !topic.reference_ids.includes(row.id))
                  .map((row) => (
                    <label className="research-reference-option" key={row.id}>
                      <input
                        type="checkbox"
                        checked={false}
                        disabled={!canEdit || topic.reference_ids.length >= 100}
                        onChange={() =>
                          setTopic((before) => ({
                            ...before,
                            reference_ids: [...before.reference_ids, row.id],
                          }))
                        }
                      />
                      {row.bibliography?.title}
                    </label>
                  ))}
                <div className="reader-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={!linkPage}
                    onClick={() => setLinkPage((value) => value - 1)}
                  >
                    이전 연결 후보
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={(linkPage + 1) * 20 >= linkTotal}
                    onClick={() => setLinkPage((value) => value + 1)}
                  >
                    다음 연결 후보
                  </button>
                </div>
              </fieldset>
              <div className="reader-actions">
                <button className="btn-primary" disabled={!canEdit || !!busy || !topic.title.trim()}>
                  논점 저장
                </button>
                <button type="button" className="btn-secondary" onClick={() => setTopic(null)}>
                  논점 작성 취소
                </button>
              </div>
            </form>
          )}
          {topics.map((item) => (
            <article
              className={`research-topic${literatureTarget?.topicId === item.id ? " project-literature-target" : ""}`}
              key={item.id}
              id={`research-topic-${item.id}`}
              tabIndex={-1}
            >
              <p className="reader-muted">{item.section === "introduction" ? "서론" : "고찰"}</p>
              <h3>{item.title}</h3>
              <p className="research-topic-body">{item.body}</p>
              {(item.references || []).map((row) => (
                <p key={row.id}>
                  {row.bibliography?.title} {linkPaper(row)}
                  {(item.cell_links || [])
                    .filter((cell) => cell.reference_id === row.id)
                    .map((cell) => (
                      <span className="research-chip" key={cell.column_id}>
                        {settings.columns.find((column) => column.id === cell.column_id)?.label ||
                          cell.column_id}
                      </span>
                    ))}
                </p>
              ))}
              <button
                className="btn-secondary"
                disabled={!canEdit || !!topic}
                onClick={() => setTopic(clone({ ...item, cell_links: item.cell_links || [] }))}
              >
                논점 편집
              </button>
            </article>
          ))}
          <div className="reader-actions">
            <button
              className="btn-secondary"
              disabled={!topicPage}
              onClick={() => setTopicPage((value) => value - 1)}
            >
              이전 논점
            </button>
            <button
              className="btn-secondary"
              disabled={(topicPage + 1) * 20 >= topicTotal}
              onClick={() => setTopicPage((value) => value + 1)}
            >
              다음 논점
            </button>
          </div>
        </>
      )}

      {tab === "export" && (
        <div className="research-export">
          <h3>연구 자료 내보내기</h3>
          <p>
            저장한 질문, 프로젝트 전체 문헌의 표·설계 판단, 서론·고찰 논점과 참고문헌을 함께 내보냅니다. 현재
            페이지나 비교 선택 수로 제한하지 않습니다.
          </p>
          <p>내보낸 문서는 해당 시점의 자료입니다. 이후 앱의 수정이 집필 중인 문서를 덮어쓰지 않습니다.</p>
          <div className="reader-actions">
            <button className="btn-primary" disabled={!!busy || dirty} onClick={() => startExport("docx")}>
              Word 문서 DOCX
            </button>
            <button className="btn-secondary" disabled={!!busy || dirty} onClick={() => startExport("csv")}>
              연구 표 CSV
            </button>
            <button className="btn-secondary" disabled={!!busy || dirty} onClick={() => startExport("ris")}>
              참고문헌 RIS
            </button>
            {googleDocsConfigured() ? (
              <button
                className="btn-primary"
                disabled={!!busy || dirty}
                onClick={() => startExport("google_docs")}
              >
                Google Docs로 보내기
              </button>
            ) : (
              <p className="reader-muted">
                Google Docs 직접 전송은 연결 설정 후 사용할 수 있습니다. DOCX를 Google Docs에서 열어 편집할 수
                있습니다.
              </p>
            )}
            {exports.getResearchExportCapabilities?.().zoteroTransfer && (
              <button
                className="btn-secondary"
                disabled={!!busy || dirty}
                onClick={() => startExport("zotero")}
              >
                Zotero 전송용 DOCX
              </button>
            )}
          </div>
          {dirty && <p className="reader-notice">작성 중인 내용을 저장하면 내보낼 수 있습니다.</p>}
          <p className="reader-muted">
            일반 DOCX의 출처 표시는 자동으로 활성 Zotero 인용이 되지 않습니다. RIS는 참고문헌
            가져오기용입니다.
          </p>
          {documentUrl && (
            <a className="btn-primary" href={documentUrl} target="_blank" rel="noreferrer">
              생성한 Google Docs 열기
            </a>
          )}
          {pendingReceipt && (
            <div className="reader-notice">
              <p>문서는 생성됐습니다. 아래 버튼은 프로젝트 기록만 다시 저장합니다.</p>
              <button
                className="btn-secondary"
                disabled={!!busy}
                onClick={() =>
                  run("receipt", async (isCurrent) => {
                    await rpc("record_research_export", pendingReceipt);
                    if (!isCurrent()) return;
                    setPendingReceipt(null);
                    setHistoryPage(0);
                    setNotice("내보내기 기록을 저장했습니다. 문서를 추가로 만들지 않았습니다.");
                    await refreshHistory(isCurrent, 0);
                  })
                }
              >
                내보내기 기록 저장 재시도
              </button>
            </div>
          )}
          <h3>내가 내보낸 문서</h3>
          <p className="reader-muted">이 기록과 Google 문서 링크는 본인에게만 표시됩니다.</p>
          {!history.length && <p>내보낸 기록이 없습니다.</p>}
          {history.map((item) => (
            <article className="research-export-history" key={item.export_id}>
              <span>
                {item.format.toUpperCase()} · {new Date(item.created_at).toLocaleString("ko-KR")} · 질문·항목
                버전 {item.workspace_revision} · 문헌 {item.reference_count}편
              </span>
              {item.url && (
                <a href={item.url} target="_blank" rel="noreferrer">
                  Google Docs 열기
                </a>
              )}
            </article>
          ))}
          {historyTotal > 20 && (
            <div className="reader-actions" aria-label="내보내기 기록 페이지">
              <span>
                {historyPage * 20 + 1}–{Math.min((historyPage + 1) * 20, historyTotal)} / {historyTotal}건
              </span>
              <button
                className="btn-secondary"
                disabled={historyPage === 0}
                onClick={() => setHistoryPage((value) => value - 1)}
              >
                이전 내보내기 기록
              </button>
              <button
                className="btn-secondary"
                disabled={(historyPage + 1) * 20 >= historyTotal}
                onClick={() => setHistoryPage((value) => value + 1)}
              >
                다음 내보내기 기록
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
