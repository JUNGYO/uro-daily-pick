import { useState } from "react";
import { Link } from "react-router-dom";
import { kstDate } from "../lib/data";
import { rpc } from "../lib/workspace";
import { useAuth } from "../lib/auth";
import { ReaderPage, PaperCard, Resource, useResource } from "../components/ReaderUI";
export default function Today() {
  const { user } = useAuth(),
    [day, setDay] = useState(kstDate());
  const r = useResource(() => rpc("reader_daily", { p_day: day }), [user.id, day]);
  return (
    <ReaderPage title="오늘 읽기" description="관심 분야의 문헌을 골라 읽고, 필요한 근거를 확인하세요.">
      <div className="reader-actions">
        <label>
          추천 날짜 <input type="date" value={day} max={kstDate()} onChange={(e) => setDay(e.target.value)} />
        </label>
        <Link className="btn-secondary" to="/discover">
          다른 문헌 찾기
        </Link>
        <Link to="/library">이어서 읽기</Link>
      </div>
      <Resource resource={r}>
        {r.data?.length ? (
          <>
            <p>{r.data.length}편 · 본문 요약 제공</p>
            {r.data.every((p) => p.read) && (
              <p role="status">오늘 추천을 모두 읽었습니다. 내 서재에서 다시 확인할 수 있습니다.</p>
            )}
            {r.data.map((p) => (
              <PaperCard key={p.id} paper={p} />
            ))}
          </>
        ) : (
          <div className="reader-empty">
            <h2>이 날짜에 제공할 추천이 없습니다</h2>
            <p>등록된 문헌을 탐색하거나 저장한 자료를 이어 읽을 수 있습니다.</p>
            <div className="reader-actions justify-center">
              <Link className="btn-primary" to="/discover">
                문헌 탐색
              </Link>
              <Link className="btn-secondary" to="/library">
                내 서재
              </Link>
            </div>
          </div>
        )}
      </Resource>
    </ReaderPage>
  );
}
