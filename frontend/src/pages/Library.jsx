import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { checked } from "../lib/data";
import { useAuth } from "../lib/auth";
import { rpc, cachedPapers, removeCached } from "../lib/workspace";
import { hasFulltextSummary } from "../lib/summary";
import {
  ReaderPage,
  Resource,
  useResource,
  PaperCard,
  ComparisonTray,
  selectComparison,
} from "../components/ReaderUI";
const columns =
  "id,pmid,title,journal,pub_date,doi,study_type,fulltext_available,summary_ko,summary_basis,summary_model,summary_source_hash,summarized_at,integrity_status";
export default function Library() {
  const { user } = useAuth(),
    [params, setParams] = useSearchParams(),
    tab = params.get("tab") || "saved",
    page = Number(params.get("page")) || 0,
    [selected, setSelected] = useState([]),
    [message, setMessage] = useState("");
  const r = useResource(async () => {
    if (tab === "offline") return cachedPapers(user.id).map((p) => ({ paper: p }));
    if (tab === "searches") return rpc("search_notifications");
    let q = supabase
      .from("reader_states")
      .select("*,paper:papers(" + columns + ")")
      .eq("user_id", user.id);
    if (tab === "saved") q = q.eq("saved", true);
    else q = q.eq("reading_state", tab);
    return checked(q.order("updated_at", { ascending: false }).range(page * 20, page * 20 + 19));
  }, [user.id, tab, page]);
  async function updateSearch(id, patch) {
    try {
      await checked(supabase.from("saved_searches").update(patch).eq("id", id));
      r.reload();
    } catch (e) {
      setMessage(e.message);
    }
  }
  return (
    <ReaderPage title="내 서재" description="저장한 문헌과 메모를 다시 열고, 연구에 활용하세요.">
      <div className="reader-actions">
        <Link className="btn-secondary" to="/collections">
          프로젝트·공동 서재
        </Link>
        <Link className="btn-secondary" to="/insights">
          읽기 통계
        </Link>
        <Link to="/discover">문헌 찾기</Link>
        <button
          className="btn-secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText("URO-" + user.id);
              setMessage("공동 서재 초대용 회원 코드를 복사했습니다.");
            } catch {
              setMessage("회원 코드: URO-" + user.id);
            }
          }}
        >
          내 초대용 회원 코드 복사
        </button>
      </div>
      <div className="reader-tabs">
        {[
          ["saved", "저장"],
          ["reading", "읽는 중"],
          ["read", "읽음"],
          ["searches", "새 문헌 알림"],
          ["offline", "오프라인 보관"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={id === tab ? "btn-primary" : "btn-secondary"}
            aria-pressed={id === tab}
            onClick={() => setParams({ tab: id })}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "offline" && (
        <p className="reader-notice">
          이 기기에 직접 보관한 요약과 서지정보입니다. 원문·그림은 포함하지 않습니다. 연결 후 최신 정정·철회
          여부를 확인하세요.
        </p>
      )}
      <Resource resource={r}>
        {tab === "searches" ? (
          <>
            <p>저장한 검색에 새로 등록된 문헌이 있으면 이곳에서 알려드립니다. 이메일 발송과 별개입니다.</p>
            {!r.data?.length && (
              <div className="reader-empty">
                <Link to="/discover">문헌 탐색에서 검색을 저장하세요.</Link>
              </div>
            )}
            {r.data?.map((s) => (
              <section className="reader-card" key={s.id}>
                <h2>{s.name}</h2>
                <p role="status">
                  새 결과 {s.new_count}편 · {s.enabled ? "알림 켜짐" : "알림 꺼짐"}
                </p>
                <p className="reader-muted">마지막 확인 {new Date(s.last_seen_at).toLocaleString("ko-KR")}</p>
                <div className="reader-actions">
                  <Link
                    className="btn-primary"
                    to={"/discover?" + new URLSearchParams({ q: s.query, ...s.filters }).toString()}
                  >
                    결과 보기
                  </Link>
                  <button
                    className="btn-secondary"
                    onClick={() => updateSearch(s.id, { last_seen_at: new Date().toISOString() })}
                  >
                    확인 완료
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => updateSearch(s.id, { enabled: !s.enabled })}
                  >
                    {s.enabled ? "알림 끄기" : "알림 켜기"}
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={async () => {
                      try {
                        await checked(supabase.from("saved_searches").delete().eq("id", s.id));
                        r.reload();
                      } catch (e) {
                        setMessage(e.message);
                      }
                    }}
                  >
                    검색 삭제
                  </button>
                </div>
              </section>
            ))}
          </>
        ) : (
          <>
            {!r.data?.length && (
              <div className="reader-empty">
                <h2>아직 보관된 문헌이 없습니다</h2>
                <Link className="btn-primary" to="/discover">
                  문헌 찾아 저장하기
                </Link>
              </div>
            )}
            {r.data
              ?.filter((s) => s.paper)
              .map((s) => (
                <PaperCard
                  key={s.paper.id}
                  paper={{
                    ...s.paper,
                    summary_ready: hasFulltextSummary(s.paper),
                    insight: hasFulltextSummary(s.paper) ? s.paper.summary_ko.split("\n")[1] : "",
                  }}
                  compare={selected.includes(s.paper.pmid)}
                  onCompare={(id) => setSelected((p) => selectComparison(p, id))}
                  extra={
                    <>
                      {s.note && <p className="reader-muted">메모 · {s.note.slice(0, 180)}</p>}
                      {s.tags?.length > 0 && <p>{s.tags.join(" · ")}</p>}
                      {tab === "offline" && (
                        <button
                          className="btn-secondary"
                          onClick={() => {
                            removeCached(user.id, s.paper.pmid);
                            r.reload();
                          }}
                        >
                          이 기기 보관 해제
                        </button>
                      )}
                    </>
                  }
                />
              ))}
            {tab !== "offline" && (
              <div className="reader-actions">
                <button
                  className="btn-secondary"
                  disabled={!page}
                  onClick={() => setParams({ tab, page: page - 1 })}
                >
                  이전 페이지
                </button>
                <button
                  className="btn-secondary"
                  disabled={(r.data?.length || 0) < 20}
                  onClick={() => setParams({ tab, page: page + 1 })}
                >
                  다음 페이지
                </button>
              </div>
            )}
          </>
        )}
      </Resource>
      <p role="status">{message}</p>
      <ComparisonTray selected={selected} setSelected={setSelected} />
    </ReaderPage>
  );
}
