import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { checked, appUrl } from "../lib/data";
import { rpc } from "../lib/workspace";
import {
  ReaderPage,
  Resource,
  useResource,
  PaperCard,
  ComparisonTray,
  selectComparison,
} from "../components/ReaderUI";
export default function Projects() {
  const { user } = useAuth(),
    [params, setParams] = useSearchParams(),
    id = Number(params.get("project")) || null,
    page = Number(params.get("page")) || 0;
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [selected, setSelected] = useState([]),
    [members, setMembers] = useState(null),
    [confirm, setConfirm] = useState(false);
  const r = useResource(
    async () => ({
      projects: await checked(
        supabase.from("collections").select("*").order("created_at", { ascending: false }),
      ),
      invitations: await rpc("project_invitations"),
    }),
    [user.id],
  );
  const detail = useResource(
    async () =>
      id
        ? {
            ...(await rpc("project_papers", { p_id: id, p_page: page })),
            suggestions: await rpc("project_recommendations", { p_id: id }),
          }
        : null,
    [id, page],
  );
  const project = r.data?.projects.find((x) => x.id === id),
    owner = project?.user_id === user.id;
  async function run(fn) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ReaderPage
      title="프로젝트·공동 서재"
      description="프로젝트별 문헌·메모·관심 주제를 관리합니다. 공유는 초대를 수락한 계정에만 적용됩니다."
    >
      <Link to="/library">← 내 서재</Link>
      <form
        className="reader-search"
        onSubmit={(e) => {
          e.preventDefault();
          const name = new FormData(e.currentTarget).get("name").trim();
          run(async () => {
            await checked(supabase.from("collections").insert({ user_id: user.id, name }));
            r.reload();
          });
        }}
      >
        <label className="query">
          새 프로젝트 이름
          <input name="name" required maxLength={80} />
        </label>
        <button className="btn-primary" disabled={busy}>
          프로젝트 만들기
        </button>
      </form>
      <p role="status">{message}</p>
      <Resource resource={r}>
        {r.data?.invitations.map((i) => (
          <div className="reader-notice" key={i.id}>
            <p>
              공동 서재 초대 · {i.name} · {i.role === "editor" ? "편집 가능" : "읽기 전용"}
            </p>
            <div className="reader-actions">
              <button
                className="btn-primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await rpc("project_invitations", { p_accept: i.id });
                    r.reload();
                  })
                }
              >
                수락
              </button>
              <button
                className="btn-secondary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await rpc("project_invitations", { p_decline: i.id });
                    r.reload();
                  })
                }
              >
                거절
              </button>
            </div>
          </div>
        ))}
        <div className="reader-actions">
          {r.data?.projects.map((c) => (
            <button
              className={c.id === id ? "btn-primary" : "btn-secondary"}
              aria-pressed={c.id === id}
              key={c.id}
              onClick={() => {
                setParams({ project: c.id });
                setMembers(null);
                setConfirm(false);
              }}
            >
              {c.name}
              {c.user_id !== user.id ? " · 공유됨" : ""}
            </button>
          ))}
        </div>
      </Resource>
      {project && (
        <>
          <h2>{project.name}</h2>
          <div className="reader-actions">
            <button
              className="btn-secondary"
              onClick={() =>
                run(async () => {
                  await navigator.clipboard.writeText(appUrl("projects?project=" + id));
                  setMessage("프로젝트 주소를 복사했습니다. 초대를 수락한 회원만 열 수 있습니다.");
                })
              }
            >
              프로젝트 주소 복사
            </button>
            {owner && (
              <button
                className="btn-secondary"
                disabled={busy}
                onClick={() => run(async () => setMembers(await rpc("project_members", { p_id: id })))}
              >
                공유 권한 관리
              </button>
            )}
          </div>
          {owner && (
            <form
              key={id}
              className="reader-card"
              onSubmit={(e) => {
                e.preventDefault();
                const keywords = new FormData(e.currentTarget)
                  .get("keywords")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .slice(0, 30);
                run(async () => {
                  await checked(supabase.from("collections").update({ keywords }).eq("id", id));
                  detail.reload();
                  r.reload();
                  setMessage("이 프로젝트의 추천 주제를 저장했습니다.");
                });
              }}
            >
              <label>
                프로젝트 추천 주제 · 영문 키워드, 쉼표로 구분
                <input
                  className="w-full"
                  name="keywords"
                  defaultValue={(project.keywords || []).join(", ")}
                  maxLength={600}
                />
              </label>
              <button className="btn-secondary" disabled={busy}>
                주제 저장
              </button>
            </form>
          )}
          {members && owner && (
            <section className="reader-card">
              <h3>공유 권한</h3>
              <p>
                서비스 회원의 이메일 또는 내 서재의 회원 코드로 초대합니다. 상대방의 공동 서재에 초대가
                표시됩니다. 원문 접근 권한은 공유되지 않습니다.
              </p>
              <form
                className="reader-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  run(async () =>
                    setMembers(
                      await rpc("project_members", {
                        p_id: id,
                        p_email: f.get("email"),
                        p_role: f.get("role"),
                      }),
                    ),
                  );
                }}
              >
                <label>
                  계정 이메일 또는 회원 코드
                  <input name="email" type="text" required />
                </label>
                <label>
                  권한
                  <select name="role">
                    <option value="reader">읽기</option>
                    <option value="editor">편집</option>
                  </select>
                </label>
                <button className="btn-primary" disabled={busy}>
                  초대 등록
                </button>
              </form>
              {members.map((m) => (
                <div key={m.user_id} className="reader-actions">
                  <span>
                    {m.email || "URO-" + m.user_id} · {m.role} · {m.accepted ? "수락됨" : "수락 대기"}
                  </span>
                  <button
                    className="btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      run(async () =>
                        setMembers(await rpc("project_members", { p_id: id, p_remove: m.user_id })),
                      )
                    }
                  >
                    접근 회수
                  </button>
                </div>
              ))}
            </section>
          )}
          <Resource resource={detail}>
            {detail.data && (
              <>
                <p>
                  프로젝트 문헌 {detail.data.total}편 · {detail.data.can_edit ? "편집 가능" : "읽기 전용"}
                </p>
                {!detail.data.items.length && (
                  <p>
                    문헌 상세의 메모·보관에서 이 프로젝트에 추가할 수 있습니다.{" "}
                    <Link to="/discover">문헌 찾기</Link>
                  </p>
                )}
                {detail.data.items.map((p) => (
                  <PaperCard
                    key={p.id}
                    paper={p}
                    compare={selected.includes(p.pmid)}
                    onCompare={(x) => setSelected((prev) => selectComparison(prev, x))}
                    extra={
                      <>
                        {detail.data.can_edit ? (
                          <form
                            key={p.id + ":" + id}
                            onSubmit={(e) => {
                              e.preventDefault();
                              const f = new FormData(e.currentTarget);
                              run(async () => {
                                await checked(
                                  supabase.from("project_notes").upsert({
                                    collection_id: id,
                                    paper_id: p.id,
                                    note: f.get("note"),
                                    tags: f
                                      .get("tags")
                                      .split(",")
                                      .map((x) => x.trim())
                                      .filter(Boolean)
                                      .slice(0, 20),
                                    updated_by: user.id,
                                    updated_at: new Date().toISOString(),
                                  }),
                                );
                                setMessage("프로젝트 메모를 저장했습니다.");
                              });
                            }}
                          >
                            <label>
                              공동 메모
                              <textarea name="note" defaultValue={p.note || ""} maxLength={6000} />
                            </label>
                            <label>
                              태그
                              <input name="tags" defaultValue={(p.tags || []).join(", ")} maxLength={600} />
                            </label>
                            <div className="reader-actions">
                              <button className="btn-secondary" disabled={busy}>
                                메모 저장
                              </button>
                              <button
                                type="button"
                                className="btn-secondary"
                                disabled={busy}
                                onClick={() =>
                                  run(async () => {
                                    await checked(
                                      supabase
                                        .from("collection_papers")
                                        .delete()
                                        .eq("collection_id", id)
                                        .eq("paper_id", p.id),
                                    );
                                    detail.reload();
                                  })
                                }
                              >
                                프로젝트에서 제외
                              </button>
                            </div>
                          </form>
                        ) : (
                          <p>{p.note || "공동 메모 없음"}</p>
                        )}
                      </>
                    }
                  />
                ))}
                <div className="reader-actions">
                  <button
                    className="btn-secondary"
                    disabled={!page}
                    onClick={() => setParams({ project: id, page: page - 1 })}
                  >
                    이전 페이지
                  </button>
                  <button
                    className="btn-secondary"
                    disabled={(page + 1) * 20 >= detail.data.total}
                    onClick={() => setParams({ project: id, page: page + 1 })}
                  >
                    다음 페이지
                  </button>
                </div>
                {detail.data.suggestions.length > 0 && (
                  <>
                    <h2>이 프로젝트의 관심 문헌</h2>
                    {detail.data.suggestions.map((p) => (
                      <PaperCard
                        key={p.id}
                        paper={p}
                        extra={
                          detail.data.can_edit && (
                            <button
                              className="btn-secondary"
                              disabled={busy}
                              onClick={() =>
                                run(async () => {
                                  await checked(
                                    supabase
                                      .from("collection_papers")
                                      .upsert({ collection_id: id, paper_id: p.id }),
                                  );
                                  detail.reload();
                                })
                              }
                            >
                              프로젝트에 추가
                            </button>
                          )
                        }
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </Resource>
          {owner && (
            <div className="reader-actions">
              {!confirm ? (
                <button className="btn-secondary" onClick={() => setConfirm(true)}>
                  프로젝트 삭제
                </button>
              ) : (
                <>
                  <p>프로젝트 목록·공동 메모·초대 권한을 삭제합니다. 개인 저장과 원문은 유지됩니다.</p>
                  <button
                    className="btn-danger"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await checked(supabase.from("collections").delete().eq("id", id));
                        setParams({});
                        setConfirm(false);
                        r.reload();
                      })
                    }
                  >
                    삭제 확인
                  </button>
                  <button className="btn-secondary" onClick={() => setConfirm(false)}>
                    취소
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
      <ComparisonTray selected={selected} setSelected={setSelected} />
    </ReaderPage>
  );
}
