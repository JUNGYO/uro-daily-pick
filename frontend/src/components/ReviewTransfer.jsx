import { createContext, useContext, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { checked } from "../lib/data";
import { rpc } from "../lib/workspace";
import { importCatalogPage } from "../lib/review";
import { projectLink, screeningLabel } from "../lib/projectFlow";
import "./projectFlow.css";

const PaperFlow = createContext(null);
export function PaperFlowActions({ paper }) {
  const flow = useContext(PaperFlow);
  if (!flow || !paper.id) return null;
  const state = flow.states?.find((s) => s.paper_id === paper.id);
  return (
    <div className="paper-flow-actions">
      {state && (
        <button
          type="button"
          className="btn-secondary"
          disabled={flow.busy}
          aria-pressed={state.saved}
          onClick={() => flow.save(paper.id, !state.saved)}
        >
          {state.saved ? "서재에 저장됨" : "서재에 저장"}
        </button>
      )}
      {flow.open && (
        <label className="reader-check">
          <input
            type="checkbox"
            checked={flow.selected.includes(paper.id)}
            disabled={flow.busy}
            onChange={() => flow.select(paper.id)}
          />
          <span>
            프로젝트에 추가 <span className="sr-only">· {paper.title}</span>
          </span>
        </label>
      )}
      {!!state?.projects?.length && (
        <div className="paper-projects" aria-label="이 문헌의 연구 프로젝트">
          {state.projects.map((p) => (
            <Link key={p.report_id || p.id} to={projectLink(p.id, p.report_id)}>
              {p.name} <span>· {screeningLabel(p)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
export default function ReviewTransfer({ papers, provenance, children }) {
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(!!params.get("project")),
    [projects, setProjects] = useState([]),
    [project, setProject] = useState(params.get("project") || ""),
    [selected, setSelected] = useState([]),
    [states, setStates] = useState(null),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stateError, setStateError] = useState(false),
    [done, setDone] = useState(null);
  const ids = (papers || [])
    .map((p) => p.id)
    .filter(Boolean)
    .slice(0, 100)
    .join(",");
  useEffect(() => {
    let live = true;
    setStates(null);
    setStateError(false);
    if (ids)
      rpc("workspace_paper_context", { p_papers: ids.split(",").map(Number) })
        .then((rows) => {
          if (!Array.isArray(rows)) throw new Error("Invalid paper context");
          if (live) setStates(rows);
        })
        .catch(() => {
          if (live) setStateError(true);
        });
    return () => {
      live = false;
    };
  }, [ids, revision]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    checked(supabase.from("collections").select("id,name").order("created_at", { ascending: false }))
      .then((rows) => {
        if (live) setProjects(rows);
      })
      .catch(() => {
        if (live) setError("프로젝트를 불러오지 못했습니다.");
      });
    return () => {
      live = false;
    };
  }, [open]);
  async function save(id, saved) {
    setBusy(true);
    setError("");
    try {
      await rpc("update_reader_state", { p_paper_id: id, p_patch: { saved } });
      setStates((rows) => rows?.map((s) => (s.paper_id === id ? { ...s, saved } : s)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function transfer() {
    if (busy) return;
    setBusy(true);
    setError("");
    setDone(null);
    try {
      const id = Number(project),
        workspace = await rpc("review_workspace", { p_project: id });
      if (!workspace.can_edit)
        throw new Error("이 프로젝트는 읽기 전용입니다. 편집 가능한 프로젝트를 선택하세요.");
      const result = await importCatalogPage(
        id,
        papers.filter((p) => selected.includes(p.id)),
        provenance,
      );
      setDone({ id, count: result.imported, existing: result.existing_reports });
      setOpen(false);
      setSelected([]);
      setRevision((n) => n + 1);
    } catch (e) {
      setError(e.message || "프로젝트에 추가하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  if (!papers?.length) return <>{children}</>;
  return (
    <PaperFlow.Provider
      value={{
        open,
        selected,
        states,
        busy,
        save,
        select: (id) => setSelected((old) => (old.includes(id) ? old.filter((x) => x !== id) : [...old, id])),
      }}
    >
      {!!papers?.length && (
        <section className="project-transfer" aria-label="문헌 보관과 프로젝트 연결">
          <div className="project-transfer-heading">
            <div>
              <strong>
                {open ? "프로젝트에 문헌 추가" : done ? "프로젝트 연결 완료" : "문헌 보관·프로젝트"}
              </strong>
              <p>서재에는 개인 보관, 프로젝트에는 선별할 문헌을 모읍니다.</p>
            </div>
            <button className="btn-secondary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? "선택 닫기" : "프로젝트에 추가"}
            </button>
          </div>
          {open && (
            <fieldset disabled={busy} className="project-transfer-controls">
              <label>
                대상 프로젝트
                <select
                  value={project}
                  onChange={(e) => {
                    setProject(e.target.value);
                    setDone(null);
                    const next = new URLSearchParams(params);
                    e.target.value ? next.set("project", e.target.value) : next.delete("project");
                    setParams(next, { replace: true });
                  }}
                >
                  <option value="">프로젝트 선택</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setSelected(papers.map((p) => p.id))}
              >
                이 페이지 전체 선택
              </button>
              {!!selected.length && (
                <button type="button" className="btn-secondary" onClick={() => setSelected([])}>
                  선택 해제
                </button>
              )}
              <button
                type="button"
                className="btn-primary"
                disabled={!project || !selected.length}
                onClick={transfer}
              >
                {busy ? "저장 중…" : `선택 ${selected.length}편 추가`}
              </button>
              {project ? (
                <Link to={projectLink(project)}>프로젝트로 이동</Link>
              ) : (
                <Link to="/projects">프로젝트 만들기</Link>
              )}
              <p className="reader-muted">
                아래 문헌 카드에서 선택하세요. 추가하면 프로젝트 목록과 선별 대기에 함께 반영됩니다.
              </p>
            </fieldset>
          )}
          {error && <p role="alert">{error}</p>}
          {stateError && (
            <p role="status">
              보관 상태를 확인하지 못했습니다.{" "}
              <button className="btn-secondary" onClick={() => setRevision((n) => n + 1)}>
                상태 다시 확인
              </button>
            </p>
          )}
          {done && (
            <p role="status">
              {done.count}편을 프로젝트에 연결했습니다.
              {done.existing > 0 && ` 기존 문헌 ${done.existing}편의 선별 기록은 유지했습니다.`}{" "}
              <Link to={`/projects?project=${done.id}&view=review&stage=reports`}>문헌 선별로 이어가기</Link>
            </p>
          )}
        </section>
      )}
      {children}
    </PaperFlow.Provider>
  );
}
