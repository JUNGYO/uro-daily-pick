import { useState } from "react";
import { Link } from "react-router-dom";
import { rpc } from "../lib/workspace";
import { Resource, useResource } from "./ReaderUI";
export default function IssueReview() {
  const r = useResource(() => rpc("admin_summary_issues"), []),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <section className="reader-shell !px-0">
      <h2>내용 검토 요청</h2>
      <Resource resource={r}>
        {!r.data?.length ? (
          <p>등록된 검토 요청이 없습니다.</p>
        ) : (
          r.data.map((i) => (
            <form
              className="reader-card"
              key={i.id}
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const f = new FormData(e.currentTarget);
                  await rpc("admin_summary_issues", {
                    p_id: i.id,
                    p_status: f.get("status"),
                    p_resolution: f.get("resolution"),
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
              <Link to={"/papers/" + i.pmid}>{i.title}</Link>
              <p>
                {i.category} · {i.message}
              </p>
              <label>
                처리 상태
                <select name="status" defaultValue={i.status}>
                  <option value="open">접수</option>
                  <option value="reviewing">검토 중</option>
                  <option value="resolved">수정 완료</option>
                  <option value="dismissed">검토 종료</option>
                </select>
              </label>
              <label>
                검토 결과
                <textarea name="resolution" defaultValue={i.resolution} maxLength={2000} />
              </label>
              <button className="btn-primary" disabled={busy}>
                처리 저장
              </button>
            </form>
          ))
        )}
      </Resource>
      <p role="status">{message}</p>
    </section>
  );
}
