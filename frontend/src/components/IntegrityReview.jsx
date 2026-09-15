import { useState } from "react";
import { Link } from "react-router-dom";
import { rpc } from "../lib/workspace";
import { Resource, useResource } from "./ReaderUI";
export default function IntegrityReview() {
  const r = useResource(() => rpc("admin_integrity_review"), []),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <section className="reader-shell !px-0">
      <h2>정정·철회 확인</h2>
      <p>
        공지 이후 재검토 대상은 오늘의 추천에서 제외됩니다. 기존 본문으로 다시 요약해도 자동 해제되지
        않습니다.
      </p>
      <Resource resource={r}>
        {r.data?.length ? (
          r.data.map((p) => (
            <form
              className="reader-card"
              key={p.id}
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
              <Link to={"/papers/" + p.pmid}>{p.title}</Link>
              <p>{{ retracted: "철회", concern: "우려 공지", corrected: "정정" }[p.integrity_status]}</p>
              {p.integrity_status !== "retracted" && (
                <>
                  <label>
                    공지·원문·요약을 확인한 결과
                    <textarea name="note" required minLength={10} maxLength={2000} />
                  </label>
                  <button className="btn-primary" disabled={busy || !p.summary_source_hash}>
                    검토 완료 기록
                  </button>
                </>
              )}
            </form>
          ))
        ) : (
          <p>재검토할 공지가 없습니다.</p>
        )}
      </Resource>
      <p role="status">{message}</p>
    </section>
  );
}
