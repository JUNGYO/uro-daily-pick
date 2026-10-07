import { useState } from "react";
import AdminPanel from "./AdminPanel";

const count = (value) => (Number.isFinite(value) ? value.toLocaleString("ko-KR") : "—");
const time = (value) =>
  value ? new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "기록 없음";
const percent = (part, total) => (total > 0 ? `${((100 * part) / total).toFixed(1)}%` : "—");

export default function UsageAnalytics({ refresh }) {
  const [days, setDays] = useState(7);
  return (
    <div className="min-w-0">
      <div className="flex justify-end gap-2 mb-2" role="group" aria-label="활용 집계 기간">
        {[7, 30].map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={days === n}
            onClick={() => setDays(n)}
            className={days === n ? "btn-primary" : "btn-secondary"}
          >
            최근 {n}일
          </button>
        ))}
      </div>
      <AdminPanel
        title="열람·활용"
        rpc="admin_reader_usage"
        params={{ p_days: days }}
        refresh={refresh}
        pollMs={30000}
      >
        {(data) => <UsageContent data={data} />}
      </AdminPanel>
    </div>
  );
}

export function UsageContent({ data }) {
  const users = data.users || [],
    daily = data.daily || [];
  const measuredDay = data.measured_since
    ? new Date(new Date(data.measured_since).getTime() + 9 * 3600000).toISOString().slice(0, 10)
    : "";
  const peak = Math.max(1, ...daily.map((d) => Math.max(d.viewing_users, d.usage_users)));
  const cards = [
    ["논문 열람", `${count(data.viewing_users)}명`, "요약 또는 원문이 표시된 사용자"],
    ["읽기 추정", `${count(data.engaged_users)}명`, "활성 열람 기준을 충족한 사용자"],
    ["저장·연구 활용", `${count(data.usage_users)}명`, "저장·메모·연구 작업을 한 사용자"],
    [
      "재이용",
      percent(data.returning_users, data.active_users),
      `활동 사용자 ${count(data.active_users)}명 중 2일 이상 이용 ${count(data.returning_users)}명`,
    ],
  ];
  return (
    <>
      <p className="text-xs text-text3 mb-4">한국 시간 기준 · {time(data.window_start)} 이후 기록</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map(([label, value, help]) => (
          <div key={label} className="border border-border rounded-lg p-3 min-w-0">
            <p className="text-xs text-text2">{label}</p>
            <p className="text-2xl font-semibold text-text1 my-2">{value}</p>
            <p className="text-xs text-text3 break-words">{help}</p>
          </div>
        ))}
      </div>
      <div className="mt-5">
        <div className="flex flex-wrap gap-4 text-xs text-text2 mb-2">
          <span>
            <span className="inline-block w-2 h-2 rounded-sm bg-accent mr-1" />
            논문 열람
          </span>
          <span>
            <span className="inline-block w-2 h-2 rounded-sm bg-success mr-1" />
            저장·연구 활용
          </span>
          <span>하루 사용자 수 · 중복 가능 · 회색은 집계 시작 전</span>
        </div>
        <div
          className="flex h-24 items-end gap-1 border-b border-border"
          role="img"
          aria-label="날짜별 열람과 활용 사용자 수"
        >
          {daily.map((day) => (
            <div
              key={day.day}
              className={
                "flex-1 flex items-end gap-px h-full min-w-0 " + (day.day < measuredDay ? "bg-border/30" : "")
              }
              title={
                day.day < measuredDay
                  ? `${day.day}: 집계 시작 전`
                  : `${day.day}: 열람 ${day.viewing_users}명, 활용 ${day.usage_users}명`
              }
            >
              <span
                className="w-1/2 bg-accent rounded-t-sm"
                style={{ height: `${(day.viewing_users / peak) * 100}%` }}
              />
              <span
                className="w-1/2 bg-success rounded-t-sm"
                style={{ height: `${(day.usage_users / peak) * 100}%` }}
              />
              <span className="sr-only">
                {day.day < measuredDay
                  ? `${day.day}: 집계 시작 전`
                  : `${day.day}: 열람 ${day.viewing_users}명, 활용 ${day.usage_users}명`}
              </span>
            </div>
          ))}
        </div>
        <div className="flex justify-between text-xs text-text3 mt-1">
          <span>{daily[0]?.day}</span>
          <span>{daily.at(-1)?.day}</span>
        </div>
      </div>
      <p className="text-sm text-text2 mt-4">
        열람 후 저장·연구 작업으로 연결:{" "}
        <strong>{percent(data.used_user_papers, data.viewed_user_papers)}</strong>
        <span className="text-xs text-text3">
          {" "}
          · 사용자별 열람 논문 {count(data.viewed_user_papers)}건 중 {count(data.used_user_papers)}건
        </span>
      </p>
      <div className="overflow-x-auto mt-4" role="region" aria-label="사용자별 열람·활용 표" tabIndex={0}>
        <table className="w-full min-w-[620px] text-sm">
          <thead>
            <tr className="text-text3 text-left border-b border-border">
              {["사용자", "요약 열람", "원문 열람", "읽기 추정", "저장", "연구 작업"].map((x) => (
                <th key={x} scope="col" className="px-2 py-2 font-medium">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u, i) => (
              <tr key={i} className="border-b border-border/50 align-top">
                <td className="px-2 py-3">
                  <details>
                    <summary className="cursor-pointer min-h-8 font-medium">{u.name || "이름 없음"}</summary>
                    <div className="text-xs text-text3 mt-2 space-y-1 max-w-64">
                      <p>
                        활동 {count(u.active_days)}일 · 활성 열람 {Math.round((u.active_seconds || 0) / 60)}분
                      </p>
                      <p>
                        좋아요 {count(u.likes)}회 · 메모 {count(u.notes)}회 · 프로젝트 추가{" "}
                        {count(u.project_adds)}회
                      </p>
                      <p>
                        선별 {count(u.screenings)}회 · 추출 {count(u.extractions)}회 · 글쓰기{" "}
                        {count(u.writing)}회 · 내보내기 {count(u.exports)}회
                      </p>
                      <p>최근 활동: {time(u.last_activity_at)}</p>
                    </div>
                  </details>
                </td>
                <td className="px-2 py-3 whitespace-nowrap">{count(u.summary_papers)}편</td>
                <td className="px-2 py-3 whitespace-nowrap">{count(u.original_papers)}편</td>
                <td className="px-2 py-3 whitespace-nowrap">{count(u.engaged_papers)}편</td>
                <td className="px-2 py-3 whitespace-nowrap">{count(u.saves)}회</td>
                <td className="px-2 py-3 whitespace-nowrap">
                  {count(u.notes + u.project_adds + u.screenings + u.extractions + u.exports + u.writing)}회
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data.active_users && (
        <p className="text-sm text-text3 mt-3">선택 기간에 수집된 열람·활용 기록이 없습니다.</p>
      )}
      <details className="mt-4 text-xs text-text3 leading-relaxed">
        <summary className="cursor-pointer min-h-8">집계 기준</summary>
        <p>
          새 집계 시작: {time(data.measured_since)}. 시작 전 기록은 소급하지 않습니다. 열람 논문 수는
          사용자별·선택 기간별 중복을 제외합니다.
        </p>
        <p>
          열람은 내용을 불러온 뒤 활성 화면에 1초 이상 표시된 경우입니다. 자동으로 선택된 오늘의 논문은 본문
          조작 또는 직접 선택 후 집계합니다. 외부 출판사 이동은 아래 클릭 집계에만 포함합니다.
        </p>
        <p>
          읽기 추정은 보이는 내용에 머문 활성 시간으로 요약 30초, 원문 60초 이상입니다. 빠른 스크롤·숨긴
          창·90초 이상 조작 없는 구간은 제외합니다. 완독·이해 여부나 읽은 비율을 확정하지 않습니다.
        </p>
        <p>
          저장·연구 작업은 저장이 성공한 행동이며, 해제 후 다시 저장하면 횟수가 늘어납니다. 내보내기는 파일
          생성·다운로드 시작을 뜻하며 Zotero 반입이나 실제 논문 인용을 보장하지 않습니다. 메모와 연구 자료의
          내용은 표시하지 않습니다.
        </p>
        <p>
          연결 비율은 같은 기간에 같은 사용자가 열람한 논문에 후속 저장·메모·프로젝트 추가·선별·추출·단일
          참고문헌 내보내기를 한 비율입니다. 논문과 연결되지 않은 작업은 비율에서 제외합니다. 재이용은 선택
          기간 중 서로 다른 날짜에 2일 이상 활동한 비율입니다.
        </p>
      </details>
    </>
  );
}
