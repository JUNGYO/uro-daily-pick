import { useMemo, useState } from "react";
import AdminPanel from "./AdminPanel";
import { supabase } from "../lib/supabase";
import { checked, withTimeout } from "../lib/data";

const dates = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  dateStyle: "medium",
  timeStyle: "short",
});
export default function MembershipReview({ refresh = 0 }) {
  const [status, setStatus] = useState("pending");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(null);
  const [notes, setNotes] = useState({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [originalDecision, setOriginalDecision] = useState(null);
  const parameters = useMemo(
    () => ({ p_status: status, p_query: search, p_page: page }),
    [status, search, page],
  );
  const review = async (person, decision) => {
    if (busy) return;
    setBusy(person.id);
    setError("");
    setMessage("");
    try {
      await withTimeout(
        checked(
          supabase.rpc("admin_review_membership", {
            p_user_id: person.id,
            p_status: decision,
            p_revision: person.access_revision,
            p_note: notes[person.id] || "",
          }),
        ),
      );
      setMessage(`${person.email}: ${decision === "approved" ? "승인했습니다" : "거절했습니다"}.`);
      setRevision((n) => n + 1);
      window.dispatchEvent(new Event("uro-membership-reviewed"));
    } catch (e) {
      setError(
        e.code === "40001"
          ? "다른 곳에서 처리한 신청입니다. 새로고침 후 확인해 주세요."
          : "처리하지 못했습니다. 목록을 새로고침해 상태를 확인한 뒤 다시 시도해 주세요.",
      );
    } finally {
      setBusy(null);
    }
  };
  const setOriginalAccess = async () => {
    if (busy || !originalDecision) return;
    const person = originalDecision;
    const enabled = !person.original_access_enabled;
    setBusy(person.id);
    setError("");
    setMessage("");
    try {
      await withTimeout(
        checked(
          supabase.rpc("admin_set_original_access", {
            p_user_id: person.id,
            p_enabled: enabled,
            p_revision: person.original_access_revision,
          }),
        ),
      );
      setMessage(`${person.email}: 원문 열람 권한을 ${enabled ? "부여했습니다" : "회수했습니다"}.`);
      setOriginalDecision(null);
      setRevision((n) => n + 1);
    } catch (e) {
      setOriginalDecision(null);
      setRevision((n) => n + 1);
      setError(
        e.code === "40001"
          ? "원문 권한이 다른 화면에서 변경됐습니다. 갱신된 상태를 확인해 주세요."
          : "원문 권한을 변경하지 못했습니다. 상태를 확인한 후 다시 시도해 주세요.",
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <div id="membership-review" className="mb-5">
      <div className="flex flex-wrap gap-2 mb-3" aria-label="가입 상태 필터">
        {[
          ["pending", "승인 대기"],
          ["approved", "승인 완료"],
          ["rejected", "거절"],
        ].map(([value, label]) => (
          <button
            key={value}
            aria-pressed={status === value}
            disabled={!!busy}
            onClick={() => {
              setStatus(value);
              setOriginalDecision(null);
              setPage(0);
              setError("");
            }}
            className={`min-h-11 px-4 rounded-lg border border-border ${status === value ? "bg-accent text-white" : "bg-card"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <form
        className="flex gap-2 mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(query.trim());
          setOriginalDecision(null);
          setPage(0);
        }}
      >
        <input
          aria-label="가입자 검색"
          placeholder="이메일, 이름, 소속 검색"
          maxLength={200}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1 min-h-11 border border-border rounded-lg px-3"
        />
        <button className="min-h-11 px-4 border border-border rounded-lg">검색</button>
      </form>
      {message && (
        <p role="status" className="text-sm mb-3 break-all">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm mb-3">
          {error}
        </p>
      )}
      <AdminPanel
        title="가입 승인"
        rpc="admin_memberships"
        params={parameters}
        refresh={`${refresh}:${revision}`}
        pollMs={30000}
      >
        {(data) => (
          <>
            <p className="font-semibold mb-3">승인 대기 {data.pending_count ?? 0}명</p>
            <p className="text-xs text-text3 mb-4">
              이메일 인증을 마친 신청자를 승인할 수 있습니다. 기존 회원은 이용을 유지합니다.
            </p>
            {!(data.items || []).length && <p className="text-sm text-text3">해당하는 가입자가 없습니다.</p>}
            <ul className="space-y-3">
              {(data.items || []).map((person) => (
                <li key={person.id} className="border border-border rounded-lg p-4 space-y-2">
                  <p className="font-semibold break-all">
                    {person.name || "이름 미입력"} · {person.email}
                  </p>
                  <p className="text-sm text-text2">{person.institution || "소속 미입력"}</p>
                  <p className="text-xs text-text3">
                    신청 {person.created_at ? dates.format(new Date(person.created_at)) : "시각 없음"} ·{" "}
                    {person.email_confirmed_at ? "이메일 인증 완료" : "이메일 인증 대기"}
                  </p>
                  {person.access_note && <p className="text-sm">이전 안내: {person.access_note}</p>}
                  {status === "approved" && (
                    <div className="space-y-2 border-t border-border pt-3">
                      <p className="text-sm">
                        원문 열람: {person.original_access_enabled ? "허용" : "차단"}
                        {person.original_access_locked ? " · 운영자 권한 유지" : ""}
                      </p>
                      {!person.original_access_locked &&
                        (originalDecision?.id === person.id ? (
                          <div
                            className="space-y-2"
                            role="group"
                            aria-label={`${person.email} 원문 권한 변경 확인`}
                          >
                            <p className="text-sm break-all">
                              {person.email} 계정의 보관된 원문·표·그림 열람 권한을
                              {originalDecision.original_access_enabled
                                ? " 회수합니다. 다음 요청부터 차단되며 이미 열린 내용은 회수할 수 없습니다."
                                : " 부여합니다. 가입 승인과 별도로 적용됩니다."}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <button
                                disabled={!!busy}
                                onClick={setOriginalAccess}
                                className="min-h-11 px-4 bg-accent text-white rounded-lg disabled:opacity-50"
                              >
                                변경 확인
                              </button>
                              <button
                                disabled={!!busy}
                                onClick={() => setOriginalDecision(null)}
                                className="min-h-11 px-4 border border-border rounded-lg"
                              >
                                취소
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            disabled={
                              !!busy || (!person.original_access_enabled && !person.email_confirmed_at)
                            }
                            onClick={() => {
                              setOriginalDecision(person);
                              setError("");
                            }}
                            className="min-h-11 px-4 border border-border rounded-lg disabled:opacity-50"
                          >
                            {person.original_access_enabled ? "원문 권한 회수" : "원문 권한 부여"}
                          </button>
                        ))}
                    </div>
                  )}
                  {status !== "approved" && (
                    <>
                      <input
                        aria-label={`${person.email} 관리자 안내`}
                        placeholder="신청자에게 보일 안내 (선택)"
                        value={notes[person.id] || ""}
                        maxLength={500}
                        disabled={!!busy}
                        onChange={(e) => setNotes((n) => ({ ...n, [person.id]: e.target.value }))}
                        className="w-full min-w-0 min-h-11 px-3 border border-border rounded-lg text-sm"
                      />
                      <div className="flex gap-2">
                        <button
                          disabled={!!busy || !person.email_confirmed_at}
                          onClick={() => review(person, "approved")}
                          className="min-h-11 px-4 bg-accent text-white rounded-lg disabled:opacity-50"
                        >
                          승인
                        </button>
                        {status === "pending" && (
                          <button
                            disabled={!!busy}
                            onClick={() => review(person, "rejected")}
                            className="min-h-11 px-4 border border-border rounded-lg disabled:opacity-50"
                          >
                            거절
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-3 mt-4">
              <button
                disabled={page === 0 || !!busy}
                onClick={() => setPage((p) => p - 1)}
                className="min-h-11 px-3 disabled:opacity-40"
              >
                이전
              </button>
              <span className="text-sm">
                {page + 1} / {Math.max(1, Math.ceil((data.total || 0) / 20))}
              </span>
              <button
                disabled={(page + 1) * 20 >= (data.total || 0) || !!busy}
                onClick={() => setPage((p) => p + 1)}
                className="min-h-11 px-3 disabled:opacity-40"
              >
                다음
              </button>
            </div>
          </>
        )}
      </AdminPanel>
    </div>
  );
}
