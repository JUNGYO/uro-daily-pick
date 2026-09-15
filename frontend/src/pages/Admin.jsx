import { useState } from "react";
import AdminPanel from "../components/AdminPanel";
import { useAuth } from "../lib/auth";
import { Users, FileText, Heart, Clock } from "lucide-react";

const ADMIN_EMAILS = ["crazyslime@gmail.com"];

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
                  label="Total Papers"
                  value={stats?.total_papers || 0}
                  sub={`+${stats?.papers_7d || 0} this week`}
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
                  sub={`${stats?.total_reads || 0} reads`}
                  color="#965500"
                />
              </div>
            );
          }}
        </AdminPanel>
        <AdminPanel title="원문 수집 상태" rpc="admin_fulltext_status" refresh={retry}>
          {(fulltexts) => (
            <>
              <p className="text-sm text-text2">
                Z8 원문 등록 {fulltexts?.local_bodies || 0}편 · 본문 요약 {fulltexts?.ready_summaries || 0}편
              </p>
              {(fulltexts?.workers || []).map((worker, index) => {
                const stale =
                  !worker.last_seen_at || Date.now() - Date.parse(worker.last_seen_at) > 2 * 60 * 60 * 1000;
                const label = stale
                  ? "연결 확인 필요"
                  : {
                      running: "작업 중",
                      idle: "다음 실행 대기",
                      error: "오류 · 다음 실행에서 재시도",
                      registered: "등록됨",
                    }[worker.state] || worker.state;
                return (
                  <p key={index} className="text-sm text-text2 mt-2">
                    {worker.name}: {label} · 최근 연결{" "}
                    {worker.last_seen_at ? new Date(worker.last_seen_at).toLocaleString() : "없음"}
                  </p>
                );
              })}
              {!fulltexts?.workers?.length && (
                <p className="text-sm text-text3 mt-2">등록된 원내망 수집기가 없습니다.</p>
              )}
              <p className="text-xs text-text3 mt-3">
                원문 수집과 Spark 요약은 독립적으로 실행됩니다. 원문은 Z8에 보관하며 요약과 필요한 정보만
                서비스에 반영합니다. 원문 등록 수는 서비스에 반영된 메타데이터 기준이며, 수집 직후 요약 대기
                중인 원문은 아직 포함되지 않을 수 있습니다.
              </p>
            </>
          )}
        </AdminPanel>
        <AdminPanel title="전체 문헌 수집" rpc="admin_catalog_status" refresh={retry}>
          {(catalog) => (
            <>
              <p className="text-sm text-text2 mt-2">
                전체 목록 {catalog?.catalog_papers || 0}편 · Qwen 요약 {catalog?.qwen_summaries || 0}편 · Qwen
                처리 대기 {catalog?.awaiting_qwen || 0}편 (원문 미확보 포함)
              </p>
              <p className="text-sm text-text2 mt-2">
                수집된 발행 기간: {catalog?.oldest_publication || "확인 중"} ~{" "}
                {catalog?.newest_publication || "확인 중"}
              </p>
              <p className="text-sm text-text2 mt-2">
                전체 기간 문헌 조회 {catalog?.metadata_examined || 0}건 · 조회 재시도{" "}
                {catalog?.metadata_unavailable || 0}건
              </p>
              {catalog?.shards?.error > 0 && (
                <p className="text-sm text-text2 mt-2">
                  일부 문헌 조회가 실패해 저장된 위치부터 재시도합니다.
                </p>
              )}
              {catalog?.storage && (
                <p className="text-sm text-text2 mt-2">
                  DB 사용량 {Math.ceil(catalog.storage.database_bytes / 1048576)}MB · 수집 저장공간 예산{" "}
                  {Math.floor(catalog.storage.budget_bytes / 1048576)}MB
                  {catalog.storage.database_bytes >= catalog.storage.budget_bytes &&
                    " — DB 예산에 도달해 새 문헌 등록이 대기 중입니다. 기존 원문 수집·요약은 계속됩니다."}
                </p>
              )}
            </>
          )}
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
          <AdminPanel title="Journals" rpc="admin_journal_dist" refresh={retry} list>
            {(journals) => (
              <>
                <div className="space-y-1.5 max-h-[240px] overflow-y-auto">
                  {journals.map((j, i) => (
                    <div key={i} className="flex items-center justify-between text-[0.778rem]">
                      <span className="text-text2 truncate flex-1 mr-2">{j.journal}</span>
                      <span className="text-text3 font-mono shrink-0">{j.paper_count}</span>
                      {j.recent_count > 0 && (
                        <span className="text-accent text-[0.667rem] ml-1 shrink-0">+{j.recent_count}</span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
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
        <AdminPanel title="User Engagement" rpc="admin_user_engagement" refresh={retry} list>
          {(users) => (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-[0.778rem]">
                  <thead>
                    <tr className="text-text3 text-left border-b border-border">
                      <th className="pb-2 font-medium">User</th>
                      <th className="pb-2 font-medium text-center">Likes</th>
                      <th className="pb-2 font-medium text-center">Skips</th>
                      <th className="pb-2 font-medium text-center">Reads</th>
                      <th className="pb-2 font-medium text-right">Last Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u, i) => (
                      <tr key={i} className="border-b border-border/50">
                        <td className="py-2">
                          <span className="text-text1 font-medium">{u.name || "—"}</span>
                          {u.institution && <span className="text-text3 ml-1.5">{u.institution}</span>}
                        </td>
                        <td className="py-2 text-center text-success font-medium">{u.likes}</td>
                        <td className="py-2 text-center text-text3">{u.dislikes}</td>
                        <td className="py-2 text-center">{u.reads}</td>
                        <td className="py-2 text-right text-text3">
                          {u.last_active ? new Date(u.last_active).toLocaleDateString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </AdminPanel>
      </div>
    </div>
  );
}
