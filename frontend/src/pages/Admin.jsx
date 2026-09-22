import IntegrityReview from "../components/IntegrityReview";
import IssueReview from "../components/IssueReview";
import { useState } from "react";
import AdminPanel from "../components/AdminPanel";
import CollectionOverview, { ProcessingHealth } from "../components/CollectionOverview";
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
                  sub={`${stats?.total_reads || 0} reads`}
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
          <AdminPanel title="저널별 원문 확보" rpc="admin_journal_fulltext_counts" refresh={retry}>
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
