import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { checked } from "../lib/data";
import { rpc } from "../lib/workspace";
import { importCatalogPage } from "../lib/review";

export default function ReviewTransfer({ papers, provenance }) {
  const [open, setOpen] = useState(false),
    [projects, setProjects] = useState([]),
    [project, setProject] = useState(""),
    [selected, setSelected] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(null);
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
  async function transfer() {
    setBusy(true);
    setError("");
    setDone(null);
    try {
      const id = Number(project),
        workspace = await rpc("review_workspace", { p_project: id });
      if (!workspace.can_edit) throw new Error("이 프로젝트에는 읽기 권한만 있습니다.");
      const items = papers.filter((p) => selected.includes(p.id));
      const result = await importCatalogPage(id, items, provenance);
      setDone({ id, count: result.imported });
      setSelected([]);
    } catch (e) {
      setError(e.message || "가져오기를 완료하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  if (!papers?.length) return null;
  return (
    <section className="reader-card">
      <button className="btn-secondary" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
        연구 프로젝트로 가져오기
      </button>
      {open && (
        <div>
          <p>선택한 문헌과 현재 검색 조건을 프로젝트의 선별 목록에 기록합니다.</p>
          {error && <p role="alert">{error}</p>}
          {done && (
            <p role="status">
              {done.count}개 검색 기록을 가져왔습니다.{" "}
              <Link to={`/projects?project=${done.id}&view=review`}>프로젝트에서 선별하기</Link>
            </p>
          )}
          <fieldset disabled={busy}>
            <label>
              대상 프로젝트
              <select value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">프로젝트 선택</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {!projects.length && (
              <p>
                <Link to="/projects">연구 프로젝트 만들기</Link>
              </p>
            )}
            <div className="reader-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setSelected(papers.map((p) => p.id))}
              >
                이 페이지 선택
              </button>
              <button type="button" className="btn-secondary" onClick={() => setSelected([])}>
                선택 해제
              </button>
            </div>
            {papers.map((p) => (
              <label key={p.id} style={{ display: "flex", gap: 8, margin: "12px 0", alignItems: "start" }}>
                <input
                  type="checkbox"
                  checked={selected.includes(p.id)}
                  onChange={() =>
                    setSelected((ids) =>
                      ids.includes(p.id) ? ids.filter((id) => id !== p.id) : [...ids, p.id],
                    )
                  }
                />
                <span>{p.title}</span>
              </label>
            ))}
            <button className="btn-primary" disabled={!project || !selected.length} onClick={transfer}>
              {busy ? "가져오는 중…" : `선택 ${selected.length}편 가져오기`}
            </button>
          </fieldset>
        </div>
      )}
    </section>
  );
}
