import { useState } from "react";
import { Link } from "react-router-dom";
import { rpc } from "../lib/workspace";
import { Resource, useResource } from "./ReaderUI";

const labels = { retracted: "철회", concern: "우려 공지", corrected: "정정" };
const noticeRelations = new Set(["RetractionIn", "ExpressionOfConcernIn", "ErratumIn"]);
const count = (n) => n.toLocaleString("ko-KR");

export default function IntegrityReview() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const r = useResource(
    () => rpc("admin_integrity_queue", { p_status: status, p_page: page }),
    [status, page],
  );
  return (
    <section
      aria-label="정정·철회 확인"
      className="bg-card rounded-xl border border-border p-4 sm:p-5 mb-4 min-w-0"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-text1">정정·철회 확인</h2>
        <button
          type="button"
          className="text-sm text-accent min-h-10 shrink-0"
          aria-expanded={open}
          aria-controls="integrity-queue"
          onClick={() => setOpen(!open)}
        >
          {open ? "목록 접기" : "목록 보기"}
        </button>
      </div>
      <Resource resource={r}>
        {r.data && (
          <>
            <p className="text-sm text-text2 mt-2">
              정정 {count(r.data.counts.corrected)}편 · 우려 공지 {count(r.data.counts.concern)}편 · 철회{" "}
              {count(r.data.counts.retracted)}편
            </p>
            <p className="text-xs text-text3 mt-2">재검토 대상과 철회 논문은 추천에서 제외됩니다.</p>
            {open && (
              <div id="integrity-queue" className="mt-4">
                <label className="text-sm text-text2">
                  공지 유형
                  <select
                    className="ml-3 border border-border rounded px-2 min-h-10 bg-card"
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      setPage(0);
                      setMessage("");
                    }}
                  >
                    <option value="all">전체</option>
                    {Object.entries(labels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-xs text-text3 my-3">{count(r.data.total)}편 · 한 페이지에 10편</p>
                {r.data.items.length ? (
                  r.data.items.map((p) => (
                    <details key={p.id} className="border-t border-border py-2">
                      <summary className="cursor-pointer text-sm text-text1 py-2 break-words">
                        <span className="font-medium mr-2">{labels[p.integrity_status]}</span>
                        {p.title}
                      </summary>
                      <div className="text-sm text-text2 space-y-3 py-2">
                        <Link className="text-accent" to={"/papers/" + p.pmid}>
                          논문 정보 열기
                        </Link>
                        <div className="flex flex-wrap gap-x-4 gap-y-2">
                          {(p.related_notices || [])
                            .filter((n) => noticeRelations.has(n.relation) && /^\d+$/.test(n.pmid))
                            .map((n) => (
                              <a
                                key={n.relation + n.pmid}
                                className="text-accent"
                                target="_blank"
                                rel="noopener noreferrer"
                                href={"https://pubmed.ncbi.nlm.nih.gov/" + n.pmid + "/"}
                              >
                                공지 원문 · PMID {n.pmid}
                              </a>
                            ))}
                        </div>
                        {p.integrity_status === "retracted" ? (
                          <p>철회 논문은 추천에서 제외됩니다.</p>
                        ) : !p.summary_source_hash ? (
                          <p>본문 요약이 등록되면 검토 결과를 기록할 수 있습니다.</p>
                        ) : (
                          <form
                            className="space-y-2"
                            onSubmit={async (e) => {
                              e.preventDefault();
                              const note = new FormData(e.currentTarget).get("note");
                              setBusy(true);
                              setMessage("");
                              try {
                                await rpc("admin_integrity_review", {
                                  p_paper_id: p.id,
                                  p_source_hash: p.summary_source_hash,
                                  p_note: note,
                                });
                                r.reload();
                                setMessage("검토 결과를 저장했습니다.");
                              } catch (e) {
                                setMessage(e.message);
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            <label className="block">
                              공지·원문·요약을 확인한 결과
                              <textarea
                                className="block w-full mt-2 border border-border rounded bg-card p-2"
                                name="note"
                                required
                                minLength={10}
                                maxLength={2000}
                              />
                            </label>
                            <button className="btn-primary" disabled={busy}>
                              검토 완료 기록
                            </button>
                          </form>
                        )}
                      </div>
                    </details>
                  ))
                ) : (
                  <p className="text-sm text-text2">재검토할 논문이 없습니다.</p>
                )}
                {r.data.total > r.data.page_size && (
                  <nav
                    aria-label="공지 목록 페이지"
                    className="flex items-center justify-between gap-3 mt-3 text-sm"
                  >
                    <button
                      type="button"
                      className="min-h-10 text-accent disabled:text-text3"
                      disabled={r.data.page === 0}
                      onClick={() => setPage(r.data.page - 1)}
                    >
                      이전
                    </button>
                    <span>
                      {r.data.page + 1} / {Math.ceil(r.data.total / r.data.page_size)}
                    </span>
                    <button
                      type="button"
                      className="min-h-10 text-accent disabled:text-text3"
                      disabled={(r.data.page + 1) * r.data.page_size >= r.data.total}
                      onClick={() => setPage(r.data.page + 1)}
                    >
                      다음
                    </button>
                  </nav>
                )}
              </div>
            )}
          </>
        )}
      </Resource>
      {message && (
        <p role="status" className="text-sm mt-3">
          {message}
        </p>
      )}
    </section>
  );
}
