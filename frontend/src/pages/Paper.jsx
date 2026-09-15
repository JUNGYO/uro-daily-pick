import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { checked, normalizePaper } from "../lib/data";
import {
  rpc,
  publisherLink,
  sharedLink,
  plainCitation,
  exportReferences,
  download,
  cachePaper,
  cachedPapers,
  removeCached,
  safeReturn,
} from "../lib/workspace";
import { ReaderPage, Resource, useResource } from "../components/ReaderUI";
import { useReading } from "../lib/useReading";
import {
  FIELDS,
  IntegrityNotice,
  SummaryContent,
  StudyContent,
  EvidenceLinks,
} from "../components/ReadingContent";
export { FIELDS };
export default function Paper() {
  const { pmid } = useParams(),
    { user } = useAuth(),
    location = useLocation(),
    [params, setParams] = useSearchParams();
  const r = useResource(async () => {
    if (!navigator.onLine) {
      const p = cachedPapers(user.id).find((p) => p.pmid === pmid);
      if (p) return { paper: p, state: {}, access: { can_read: false }, issues: [], offline: true };
      throw new Error("이 문헌은 오프라인 보관함에 없습니다.");
    }
    return rpc("reader_paper", { p_pmid: pmid });
  }, [pmid, user.id]);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [note, setNote] = useState(""),
    [tags, setTags] = useState(""),
    [report, setReport] = useState(false),
    [projects, setProjects] = useState([]);
  useReading(user.id, r.data?.paper?.id, r.data?.offline, r.data?.state?.position);
  const tab = params.get("tab") || "summary";
  useEffect(() => {
    setMessage("");
    setReport(false);
    setNote(r.data?.state?.note || "");
    setTags((r.data?.state?.tags || []).join(", "));
    if (
      r.data?.paper?.id &&
      !r.data.offline &&
      (!r.data.state?.reading_state || r.data.state.reading_state === "unread")
    ) {
      const paperId = r.data.paper.id;
      rpc("update_reader_state", { p_paper_id: paperId, p_patch: { reading_state: "reading" } })
        .then((state) =>
          r.setData((current) => (current?.paper?.id === paperId ? { ...current, state } : current)),
        )
        .catch(() => {});
    }
  }, [r.data?.paper?.id]);
  useEffect(() => {
    let live = true;
    checked(supabase.from("collections").select("id,name").order("name"))
      .then((x) => {
        if (live) setProjects(x || []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [user.id]);
  async function run(fn) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(e.message || "저장하지 못했습니다. 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }
  async function state(patch) {
    const s = await rpc("update_reader_state", { p_paper_id: r.data.paper.id, p_patch: patch });
    r.setData((d) => ({ ...d, state: s }));
    setMessage("저장했습니다.");
  }
  const p = r.data?.paper ? normalizePaper(r.data.paper) : null;
  const s = r.data?.state || {};
  function evidence(id) {
    return (
      <EvidenceLinks
        paper={p}
        claim={id}
        canRead={r.data?.access?.can_read && !r.data?.offline}
        returnTo={location.pathname + location.search}
      />
    );
  }
  return (
    <ReaderPage title={p?.title || "논문 상세"}>
      <Link className="text-accent underline" to={safeReturn(location.state?.returnTo || "/discover")}>
        ← 목록으로
      </Link>
      <Resource resource={r}>
        {!p ? (
          <div className="reader-empty">
            등록된 문헌에서 찾지 못했습니다. <Link to="/discover">문헌 탐색</Link>
          </div>
        ) : (
          <>
            <p className="reader-muted">
              {p.journal} · {p.pub_date} · PMID {p.pmid}
            </p>
            {r.data.offline && (
              <div className="reader-notice">
                오프라인 보관본 · {new Date(p.cached_at).toLocaleString("ko-KR")}. 최근 정정·철회 여부는 연결
                후 확인해 주세요.
              </div>
            )}
            <IntegrityNotice paper={p} />
            <div className="reader-actions">
              <button
                className={s.saved ? "btn-primary" : "btn-secondary"}
                disabled={busy || r.data.offline}
                aria-pressed={!!s.saved}
                onClick={() => run(() => state({ saved: !s.saved }))}
              >
                {s.saved ? "저장됨" : "내 서재에 저장"}
              </button>
              <button
                className="btn-secondary"
                disabled={busy || r.data.offline}
                aria-pressed={s.reading_state === "read"}
                onClick={() =>
                  run(() => state({ reading_state: s.reading_state === "read" ? "unread" : "read" }))
                }
              >
                {s.reading_state === "read" ? "읽음" : "읽음 표시"}
              </button>
              <button
                className="btn-secondary"
                onClick={() =>
                  run(async () => {
                    const data = { title: p.title, url: sharedLink(p) };
                    if (navigator.share) await navigator.share(data);
                    else {
                      await navigator.clipboard.writeText(data.url);
                      setMessage("논문 주소를 복사했습니다.");
                    }
                  })
                }
              >
                공유
              </button>
              <button
                className="btn-secondary"
                onClick={() =>
                  run(async () => {
                    await navigator.clipboard.writeText(plainCitation(p));
                    setMessage("인용문을 복사했습니다.");
                  })
                }
              >
                인용 복사
              </button>
            </div>
            {s.position > 0.02 && (
              <button
                className="btn-secondary"
                onClick={() => {
                  const el = document.querySelector(".reader-scroll");
                  el.scrollTop = s.position * (el.scrollHeight - el.clientHeight);
                }}
              >
                이전 읽기 위치로
              </button>
            )}
            <div className="reader-tabs" aria-label="논문 내용">
              {[
                ["summary", "요약"],
                ["study", "연구 상세·Q&A"],
                ["original", "근거·원문"],
                ["notes", "메모·보관"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  className={tab === id ? "btn-primary" : "btn-secondary"}
                  aria-pressed={tab === id}
                  onClick={() => setParams({ tab: id })}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === "summary" && <SummaryContent paper={p} evidence={evidence} />}
            {tab === "study" && <StudyContent paper={p} evidence={evidence} />}
            {tab === "original" && (
              <>
                <h2>원문과 근거 확인</h2>
                {r.data.access?.can_read && !r.data.offline ? (
                  <Link
                    className="btn-primary"
                    to={"/fulltext/" + pmid}
                    state={{ returnTo: location.pathname + location.search }}
                  >
                    원문·표·그림 보기
                  </Link>
                ) : (
                  <p>
                    이 계정으로 서비스에 보관된 원문을 열 수 없습니다. 출판사나 소속 기관에서 접근 가능 여부를
                    확인해 주세요.
                  </p>
                )}
                <div className="reader-actions">
                  <a className="btn-secondary" href={publisherLink(p)} target="_blank" rel="noreferrer">
                    출판사에서 확인
                  </a>
                  <a
                    className="btn-secondary"
                    href={"https://pubmed.ncbi.nlm.nih.gov/" + pmid + "/"}
                    target="_blank"
                    rel="noreferrer"
                  >
                    PubMed
                  </a>
                </div>
                <p className="reader-muted">
                  본문 기반 요약, 근거 위치 연결, 전문가 검토는 서로 다른 상태입니다. 이 서비스는 전문가 검토
                  완료를 표시하지 않습니다.
                </p>
              </>
            )}
            {tab === "notes" && (
              <>
                <label>
                  개인 메모
                  <textarea maxLength={6000} value={note} onChange={(e) => setNote(e.target.value)} />
                </label>
                <label>
                  태그 · 쉼표로 구분
                  <input
                    className="w-full"
                    maxLength={600}
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                  />
                </label>
                {s.summary_hash && s.summary_hash !== p.summary_source_hash && (
                  <p className="reader-notice">
                    메모를 작성한 뒤 요약의 근거가 변경됐습니다. 현재 요약을 다시 확인해 주세요.
                  </p>
                )}
                <div className="reader-actions">
                  <button
                    className="btn-primary"
                    disabled={busy || r.data.offline}
                    onClick={() =>
                      run(() =>
                        state({
                          note,
                          tags: tags
                            .split(",")
                            .map((x) => x.trim())
                            .filter(Boolean)
                            .slice(0, 20),
                          summary_hash: p.summary_source_hash,
                        }),
                      )
                    }
                  >
                    메모 저장
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() =>
                      run(async () => {
                        cachePaper(user.id, p);
                        setMessage("이 기기에 서지정보와 요약을 보관했습니다. 최대 100편까지 보관합니다.");
                      })
                    }
                  >
                    요약 오프라인 보관
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      removeCached(user.id, p.pmid);
                      setMessage("이 기기의 보관본을 삭제했습니다.");
                    }}
                  >
                    오프라인 보관 해제
                  </button>
                </div>
                <label>
                  프로젝트에 추가
                  <select
                    defaultValue=""
                    disabled={busy || r.data.offline}
                    onChange={(e) => {
                      const id = Number(e.target.value);
                      if (id)
                        run(async () => {
                          await checked(
                            supabase.from("collection_papers").upsert({ collection_id: id, paper_id: p.id }),
                          );
                          setMessage("프로젝트에 추가했습니다.");
                        });
                    }}
                  >
                    <option value="">프로젝트 선택</option>
                    {projects.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p>
                  <Link to="/collections">프로젝트 관리</Link>
                </p>
                <div className="reader-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => download("PMID" + p.pmid + ".ris", exportReferences([p], "ris"))}
                  >
                    RIS 내보내기
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => download("PMID" + p.pmid + ".bib", exportReferences([p], "bib"))}
                  >
                    BibTeX 내보내기
                  </button>
                </div>
                <p className="reader-muted">원문에 없는 권·호·쪽 정보는 내보내기에 포함하지 않습니다.</p>
              </>
            )}
            <div className="reader-actions">
              <button
                className="btn-secondary"
                disabled={busy || r.data.offline}
                aria-pressed={r.data.opinion === "dislike"}
                onClick={() =>
                  run(async () => {
                    const a = r.data.opinion === "dislike" ? "none" : "dislike";
                    await rpc("reader_opinion", { p_paper_id: p.id, p_action: a });
                    r.setData((d) => ({ ...d, opinion: a }));
                    setMessage(
                      a === "none"
                        ? "추천 의견을 취소했습니다."
                        : "추천에 반영했습니다. 저장 상태는 유지됩니다.",
                    );
                  })
                }
              >
                {r.data.opinion === "dislike" ? "관심 없음 취소" : "관심 없음"}
              </button>
              <button className="btn-secondary" onClick={() => setReport((x) => !x)}>
                내용 오류 알리기
              </button>
            </div>
            {report && (
              <form
                className="reader-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  run(async () => {
                    await checked(
                      supabase.from("summary_issues").insert({
                        user_id: user.id,
                        paper_id: p.id,
                        category: f.get("category"),
                        message: f.get("message"),
                        source_hash: p.summary_source_hash,
                      }),
                    );
                    setReport(false);
                    setMessage("검토 요청을 등록했습니다. 이 문헌에서 처리 상태를 확인할 수 있습니다.");
                    r.reload();
                  });
                }}
              >
                <label>
                  문제 유형
                  <select name="category">
                    <option value="summary">요약·수치</option>
                    <option value="classification">주제 분류</option>
                    <option value="original">원문 접근</option>
                    <option value="figure">표·그림</option>
                  </select>
                </label>
                <label>
                  확인할 내용
                  <textarea name="message" required maxLength={2000} />
                </label>
                <button className="btn-primary" disabled={busy || r.data.offline}>
                  검토 요청
                </button>
              </form>
            )}
            {r.data.issues?.length > 0 && (
              <details>
                <summary>내 검토 요청 {r.data.issues.length}건</summary>
                {r.data.issues.map((i) => (
                  <div className="reader-card" key={i.id}>
                    <p>
                      {
                        { open: "접수", reviewing: "검토 중", resolved: "수정 완료", dismissed: "검토 종료" }[
                          i.status
                        ]
                      }{" "}
                      · {i.message}
                    </p>
                    {i.resolution && <p>{i.resolution}</p>}
                  </div>
                ))}
              </details>
            )}
            <p role="status">{message}</p>
          </>
        )}
      </Resource>
    </ReaderPage>
  );
}
