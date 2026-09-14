import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { withTimeout } from "../lib/data";
import { ErrorNotice } from "../components/Status";
import { useAuth } from "../lib/auth";
import { Loader2, Users, FileText, Heart, TrendingUp, BookOpen, Clock } from "lucide-react";

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
  const [stats, setStats] = useState(null);
  const [daily, setDaily] = useState([]);
  const [topPapers, setTopPapers] = useState([]);
  const [keywords, setKeywords] = useState([]);
  const [journals, setJournals] = useState([]);
  const [users, setUsers] = useState([]);
  const [fulltexts, setFulltexts] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  const isAdmin = ADMIN_EMAILS.includes(user?.email);

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const [s, d, tp, kw, j, u, ft, cat] = await withTimeout(
          Promise.all([
            supabase.rpc("admin_stats"),
            supabase.rpc("admin_daily_activity"),
            supabase.rpc("admin_top_papers", { lim: 10 }),
            supabase.rpc("admin_popular_keywords"),
            supabase.rpc("admin_journal_dist"),
            supabase.rpc("admin_user_engagement"),
            supabase.rpc("admin_fulltext_status"),
            supabase.rpc("admin_catalog_status"),
          ]),
        );
        if ([s, d, tp, kw, j, u, ft, cat].some((result) => result.error)) {
          throw new Error("Could not load admin analytics.");
        }
        if (!active) return;
        setStats(s.data);
        setDaily(d.data || []);
        setTopPapers(tp.data || []);
        setKeywords(kw.data || []);
        setJournals(j.data || []);
        setUsers(u.data || []);
        setFulltexts(ft.data);
        setCatalog(cat.data);
      } catch {
        if (active) setError("Could not load admin analytics. Please check your access and retry.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [isAdmin, retry]);

  if (!isAdmin)
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-text3">Access denied</p>
      </div>
    );

  if (loading)
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={32} className="text-accent animate-spin" />
      </div>
    );

  if (error)
    return (
      <div className="p-6">
        <ErrorNotice message={error} onRetry={() => setRetry((r) => r + 1)} />
      </div>
    );

  const likeRate =
    stats?.total_feedbacks > 0 ? Math.round((stats.total_likes / stats.total_feedbacks) * 100) : 0;

  return (
    <div tabIndex={0} role="region" aria-label="Admin content" className="h-full overflow-y-auto">
      <div className="max-w-[960px] mx-auto p-4 sm:p-6">
        <h1 className="text-[1.333rem] font-bold text-text1 mb-5">Admin Dashboard</h1>

        {/* Stats grid */}
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

        <section
          aria-label="원문 수집 상태"
          className="bg-card rounded-xl border border-border p-4 sm:p-5 mb-6"
        >
          <h2 className="font-semibold text-text1 mb-3">원문 수집 · 본문 요약</h2>
          <p className="text-sm text-text2">
            Z8 원문 {fulltexts?.local_bodies || 0}편 · 본문 요약 {fulltexts?.ready_summaries || 0}편
          </p>
          <p className="text-sm text-text2 mt-2">
            전체 목록 {catalog?.catalog_papers || 0}편 · Qwen 요약 {catalog?.qwen_summaries || 0}편 · Qwen
            처리 대기 {catalog?.awaiting_qwen || 0}편
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
            <p className="text-sm text-text2 mt-2">일부 문헌 조회가 실패해 저장된 위치부터 재시도합니다.</p>
          )}
          {(fulltexts?.workers || []).map((worker, index) => {
            const stale =
              !worker.last_seen_at || Date.now() - Date.parse(worker.last_seen_at) > 2 * 60 * 60 * 1000;
            const label = stale
              ? "연결 확인 필요"
              : {
                  running: "수집 중",
                  idle: "다음 수집 대기",
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
            Z8에 로그인한 동안 원문을 수집하고 Spark로 요약합니다. 원문은 Z8에 보관하며 요약과 필요한 정보만
            서비스에 반영합니다.
          </p>
          <button type="button" onClick={() => setRetry((r) => r + 1)} className="text-sm text-accent mt-3">
            상태 새로고침
          </button>
        </section>

        {/* Daily activity chart */}
        <div
          className="bg-card rounded-xl border border-border p-4 sm:p-5 mb-6"
          style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}
        >
          <h2 className="text-[0.889rem] font-semibold text-text1 mb-4">Daily Activity (30 days)</h2>
          <div className="flex items-end gap-1" style={{ height: 120 }}>
            {daily.map((d, i) => {
              const max = Math.max(...daily.map((x) => (x.likes || 0) + (x.dislikes || 0)), 1);
              const total = (d.likes || 0) + (d.dislikes || 0);
              const h = Math.max(2, (total / max) * 100);
              const likeH = total > 0 ? (d.likes / total) * h : 0;
              return (
                <div
                  key={i}
                  className="flex-1 flex flex-col justify-end items-center gap-0"
                  title={`${d.date}: ${d.likes}L ${d.dislikes}D ${d.active_users}U`}
                >
                  <div
                    className="w-full rounded-t"
                    style={{ height: likeH + "%", background: "#187A36", minHeight: likeH > 0 ? 1 : 0 }}
                  />
                  <div
                    className="w-full"
                    style={{ height: h - likeH + "%", background: "#E5E5EA", minHeight: total > 0 ? 1 : 0 }}
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
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Popular keywords */}
          <div
            className="bg-card rounded-xl border border-border p-4"
            style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}
          >
            <h2 className="text-[0.889rem] font-semibold text-text1 mb-3">Popular Keywords</h2>
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
          </div>

          {/* Journal distribution */}
          <div
            className="bg-card rounded-xl border border-border p-4"
            style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}
          >
            <h2 className="text-[0.889rem] font-semibold text-text1 mb-3">Journals</h2>
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
          </div>
        </div>

        {/* Top liked papers */}
        <div
          className="bg-card rounded-xl border border-border p-4 sm:p-5 mb-6"
          style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}
        >
          <h2 className="text-[0.889rem] font-semibold text-text1 mb-3">Most Liked Papers</h2>
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
            {!topPapers.length && <p className="text-text3 text-[0.833rem] text-center py-4">No likes yet</p>}
          </div>
        </div>

        {/* User engagement */}
        <div
          className="bg-card rounded-xl border border-border p-4 sm:p-5"
          style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}
        >
          <h2 className="text-[0.889rem] font-semibold text-text1 mb-3">User Engagement</h2>
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
        </div>
      </div>
    </div>
  );
}
