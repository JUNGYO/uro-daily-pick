import IntegrityReview from "../components/IntegrityReview";
import IssueReview from "../components/IssueReview";
import { useState } from "react";
import AdminPanel from "../components/AdminPanel";
import CollectionOverview, { ProcessingHealth } from "../components/CollectionOverview";
import { useAuth } from "../lib/auth";
import { Users, FileText, Heart, Clock } from "lucide-react";

const ADMIN_EMAILS = ["crazyslime@gmail.com"];
const activityDateFormat = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function ActivityTime({ value, empty = "기록 없음" }) {
  if (value === null) return empty;
  if (!value || !Number.isFinite(new Date(value).getTime())) return "확인 불가";
  return <time dateTime={value}>{activityDateFormat.format(new Date(value))}</time>;
}

function StatCard({ icon: Icon, label, value, sub, color }) {
  return (
    <div
      className="bg-card rounded-xl border border-border p-4"
      style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}
    >
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: color + "14" }}
        >
          <Icon size={20} style={{ color }} />
        </div>
        <div>
          <p className="text-[1.222rem] font-bold text-text1">{value}</p>
          <p className="text-[0.722rem] text-text3">{label}</p>
        </div>
        {sub && (
          <span className="ml-auto text-[0.722rem] text-text3 bg-hover px-2 py-0.5 rounded">{sub}</span>
        )}
      </div>
    </div>
  );
}

export default function Admin() {
  const { user } = useAuth();
  const [retry, setRetry] = useState(0);
  const isAdmin = ADMIN_EMAILS.includes(user?.email?.trim().toLowerCase());

  if (!isAdmin)
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-text3">Access denied</p>
      </div>
    );

  return (
    <div tabIndex={0} role="region" aria-label="Admin content" className="h-full overflow-y-auto">
      <div key={user.id} className="max-w-[960px] mx-auto p-4 sm:p-6">
        <h1 className="text-[1.333rem] font-bold text-text1 mb-5">Admin Dashboard</h1>

        <button
          type="button"
          onClick={() => setRetry((r) => r + 1)}
          className="text-sm text-accent mb-4 min-h-11 px-3 border border-border rounded-lg"
        >
          상태 새로고침
        </button>
        <AdminPanel title="문헌 처리 현황" rpc="admin_catalog_status" refresh={retry} pollMs={30000}>
          {(catalog) => (
            <>
              <CollectionOverview catalog={catalog} />
            </>
          )}
        </AdminPanel>
        <IssueReview />
        <IntegrityReview />
        <AdminPanel title="자동 처리 상태" rpc="admin_worker_status" refresh={retry} pollMs={30000}>
          {(status) => <ProcessingHealth workers={status?.workers || []} />}
        </AdminPanel>

        <AdminPanel title="서비스 이용 현황" rpc="admin_stats" refresh={retry}>
          {(stats) => {
            const likeRate =
              stats.total_feedbacks > 0 ? Math.round((stats.total_likes / stats.total_feedbacks) * 100) : 0;
            return (
              <div className="grid grid-cols-1 min-[400px]:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
                <StatCard
                  icon={Users}
                  label="Total Users"
                  value={stats?.total_users || 0}
                  sub={`${stats?.active_users_7d || 0} active`}
                  color="#0066CC"
                />
                <StatCard
                  icon={FileText}
                  label="등록 문헌 정보"
                  value={Number.isFinite(stats?.total_papers) ? stats.total_papers : "—"}
                  sub={Number.isFinite(stats?.papers_7d) ? `+${stats.papers_7d} this week` : "집계 중"}
                  color="#187A36"
                />
                <StatCard
                  icon={Heart}
                  label="Like Rate"
                  value={`${likeRate}%`}
                  sub={`${stats?.total_likes || 0} / ${stats?.total_feedbacks || 0}`}
                  color="#C32D26"
                />
                <StatCard
                  icon={Clock}
                  label="Avg Dwell"
                  value={`${stats?.avg_dwell_seconds || 0}s`}
                  sub={`체류 기록 ${stats?.total_reads || 0}회`}
                  color="#965500"
                />
              </div>
            );
          }}
        </AdminPanel>
        {/* Daily activity chart */}
        <AdminPanel title="Daily Activity (30 days)" rpc="admin_daily_activity" refresh={retry} list>
          {(daily) => (
            <>
              <div className="flex items-end gap-1" style={{ height: 120 }}>
                {daily.map((d, i) => {
                  const max = Math.max(...daily.map((x) => (x.likes || 0) + (x.dislikes || 0)), 1);
                  const total = (d.likes || 0) + (d.dislikes || 0);
                  const h = Math.max(2, (total / max) * 100);
                  const likeH = total > 0 ? (d.likes / total) * h : 0;
                  return (
                    <div
                      key={i}
                      className="flex-1 h-full flex flex-col justify-end items-center gap-0"
                      title={`${d.date}: ${d.likes}L ${d.dislikes}D ${d.active_users}U`}
                    >
                      <div
                        className="w-full rounded-t"
                        style={{ height: likeH + "%", background: "#187A36", minHeight: likeH > 0 ? 1 : 0 }}
                      />
                      <div
                        className="w-full"
                        style={{
                          height: h - likeH + "%",
                          background: "#E5E5EA",
                          minHeight: total > 0 ? 1 : 0,
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between mt-2 text-[0.611rem] text-text3">
                <span>{daily[0]?.date?.slice(5)}</span>
                <span className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-success" />
                    Likes
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-border" />
                    Skips
                  </span>
                </span>
                <span>{daily[daily.length - 1]?.date?.slice(5)}</span>
              </div>
            </>
          )}
        </AdminPanel>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Popular keywords */}
          <AdminPanel title="Popular Keywords" rpc="admin_popular_keywords" refresh={retry} list>
            {(keywords) => (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {keywords.map((k, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[0.722rem] font-medium bg-hover border border-border text-text2"
                    >
                      {k.keyword} <span className="text-text3">{k.user_count}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </AdminPanel>

          {/* Journal distribution */}
          <AdminPanel
            title="저널별 원문 확보"
            rpc="admin_journal_fulltext_counts"
            refresh={retry}
            pollMs={30000}
          >
            {({ counts_available, journals }) =>
              !counts_available ? (
                <p role="status" className="text-sm text-text3">
                  원문 확보 현황을 집계 중입니다.
                </p>
              ) : (
                <>
                  <p className="text-xs text-text3 mb-3">서비스에 반영된 원문 · 상위 30개 저널</p>
                  {journals.length === 0 && <p className="text-sm text-text3">확보된 원문이 없습니다.</p>}
                  <div className="space-y-1.5 max-h-[240px] overflow-y-auto">
                    {journals.map((j, i) => (
                      <div key={i} className="flex items-center justify-between text-[0.778rem]">
                        <span className="text-text2 truncate flex-1 mr-2" title={j.journal || "저널 미상"}>
                          {j.journal || "저널 미상"}
                        </span>
                        <span className="text-text3 font-mono shrink-0">
                          {j.fulltext_count.toLocaleString("ko-KR")}편
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )
            }
          </AdminPanel>
        </div>

        {/* Top liked papers */}
        <AdminPanel
          title="Most Liked Papers"
          rpc="admin_top_papers"
          refresh={retry}
          list
          params={{ lim: 10 }}
        >
          {(topPapers) => (
            <>
              <div className="space-y-2">
                {topPapers.map((p, i) => (
                  <div key={i} className="flex items-start gap-3 p-2 rounded-lg hover:bg-hover">
                    <span className="text-[0.778rem] font-bold text-accent shrink-0 w-5 text-right">
                      {p.like_count}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[0.778rem] font-medium text-text1 leading-snug">{p.title}</p>
                      <p className="text-[0.667rem] text-text3 mt-0.5">
                        {p.journal} · {p.pub_date}
                      </p>
                    </div>
                  </div>
                ))}
                {!topPapers.length && (
                  <p className="text-text3 text-[0.833rem] text-center py-4">No likes yet</p>
                )}
              </div>
            </>
          )}
        </AdminPanel>

        {/* User engagement */}
        <AdminPanel title="User Engagement" rpc="admin_user_engagement" refresh={retry} pollMs={30000} list>
          {(users) => (
            <>
              <div
                className="overflow-x-auto"
                tabIndex={0}
                role="region"
                aria-label="사용자 로그인·읽기 현황 표"
              >
                <table className="w-full min-w-[850px] text-[0.778rem]">
                  <thead>
                    <tr className="text-text3 text-left border-b border-border">
                      <th className="pb-2 font-medium">User</th>
                      <th className="pb-2 px-2 font-medium text-center">Likes</th>
                      <th className="pb-2 px-2 font-medium text-center">Skips</th>
                      <th className="pb-2 font-medium text-center">열람 클릭</th>
                      <th className="pb-2 font-medium text-right">최근 접속</th>
                      <th className="pb-2 font-medium text-right">최근 로그인 인증</th>
                      <th className="pb-2 font-medium text-right">최근 열람 클릭</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u, i) => (
                      <tr key={i} className="border-b border-border/50">
                        <td className="py-2">
                          <span className="text-text1 font-medium">{u.name || "—"}</span>
                          {u.institution && <span className="text-text3 ml-1.5">{u.institution}</span>}
                        </td>
                        <td className="py-2 px-2 text-center text-success font-medium">{u.likes}</td>
                        <td className="py-2 px-2 text-center text-text3">{u.dislikes}</td>
                        <td className="py-2 text-center whitespace-nowrap">
                          <span
                            title={`논문 상세 ${u.detail_clicks ?? "—"}회 · 원문 ${u.original_clicks ?? "—"}회 · 출판사 ${u.publisher_clicks ?? "—"}회`}
                          >
                            {Number.isFinite(u.open_clicks) ? `${u.open_clicks}회` : "확인 불가"}
                          </span>
                          <span className="block text-text3 text-xs">
                            {Number.isFinite(u.opened_papers) ? `${u.opened_papers}편` : "편수 확인 불가"}
                          </span>
                        </td>
                        <td className="py-2 pl-3 text-right text-text3 whitespace-nowrap">
                          <ActivityTime value={u.last_seen_at} empty="집계 시작 후 기록 없음" />
                        </td>
                        <td className="py-2 pl-3 text-right text-text3 whitespace-nowrap">
                          <ActivityTime value={u.last_sign_in_at} />
                        </td>
                        <td className="py-2 pl-3 text-right text-text3 whitespace-nowrap">
                          <ActivityTime value={u.last_opened_at} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-text3 mt-3">
                최근 접속은 로그인 유지 상태의 재방문도 포함합니다. 로그인 인증은 새로 로그인한 시각입니다.
                시간은 한국 시간(KST)입니다.
              </p>
              <p className="text-xs text-text3 mt-2">
                열람 클릭은 서비스에서 논문 상세·원문·출판사 링크를 직접 선택한 횟수입니다. 같은 논문을 다시
                열면 횟수는 늘고 편수는 중복을 제외합니다. 읽기 완료를 뜻하지 않습니다.
              </p>
              <p className="text-xs text-text3 mt-2">
                클릭 집계 적용 이후의 기록입니다. 자동 표시·새로고침과 이전 10초 체류 기록은 포함하지
                않습니다. 체류시간은 별도로 집계합니다.
              </p>
            </>
          )}
        </AdminPanel>
      </div>
    </div>
  );
}
