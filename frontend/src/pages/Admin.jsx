import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import { Loader2, Users, FileText, Heart, TrendingUp, BookOpen, Clock } from "lucide-react";

const ADMIN_EMAILS = ["crazyslime@gmail.com"];

function StatCard({ icon: Icon, label, value, sub, color }) {
  return (
    <div className="bg-card rounded-xl border border-border p-4" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: color + "14" }}>
          <Icon size={20} style={{ color }} />
        </div>
        <div>
          <p className="text-[1.222rem] font-bold text-text1">{value}</p>
          <p className="text-[0.722rem] text-text3">{label}</p>
        </div>
        {sub && <span className="ml-auto text-[0.722rem] text-text3 bg-hover px-2 py-0.5 rounded">{sub}</span>}
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
  const [loading, setLoading] = useState(true);

  const isAdmin = ADMIN_EMAILS.includes(user?.email);

  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      const [s, d, tp, kw, j, u] = await Promise.all([
        supabase.rpc("admin_stats"),
        supabase.rpc("admin_daily_activity"),
        supabase.rpc("admin_top_papers", { lim: 10 }),
        supabase.rpc("admin_popular_keywords"),
        supabase.rpc("admin_journal_dist"),
        supabase.rpc("admin_user_engagement"),
      ]);
      setStats(s.data);
      setDaily(d.data || []);
      setTopPapers(tp.data || []);
      setKeywords(kw.data || []);
      setJournals(j.data || []);
      setUsers(u.data || []);
      setLoading(false);
    })();
  }, [isAdmin]);

  if (!isAdmin) return (
    <div className="flex items-center justify-center h-full">
      <p className="text-text3">Access denied</p>
    </div>
  );

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <Loader2 size={32} className="text-accent animate-spin" />
    </div>
  );

  const likeRate = stats?.total_feedbacks > 0
    ? Math.round(stats.total_likes / stats.total_feedbacks * 100) : 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[960px] mx-auto p-4 sm:p-6">
        <h1 className="text-[1.333rem] font-bold text-text1 mb-5">Admin Dashboard</h1>

        {/* Stats grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <StatCard icon={Users} label="Total Users" value={stats?.total_users || 0} sub={`${stats?.active_users_7d || 0} active`} color="#007AFF" />
          <StatCard icon={FileText} label="Total Papers" value={stats?.total_papers || 0} sub={`+${stats?.papers_7d || 0} this week`} color="#34C759" />
          <StatCard icon={Heart} label="Like Rate" value={`${likeRate}%`} sub={`${stats?.total_likes || 0} / ${stats?.total_feedbacks || 0}`} color="#FF3B30" />
          <StatCard icon={Clock} label="Avg Dwell" value={`${stats?.avg_dwell_seconds || 0}s`} sub={`${stats?.total_reads || 0} reads`} color="#FF9500" />
        </div>

        {/* Daily activity chart */}
        <div className="bg-card rounded-xl border border-border p-4 sm:p-5 mb-6" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
          <h2 className="text-[0.889rem] font-semibold text-text1 mb-4">Daily Activity (30 days)</h2>
          <div className="flex items-end gap-1" style={{ height: 120 }}>
            {daily.map((d, i) => {
              const max = Math.max(...daily.map(x => (x.likes || 0) + (x.dislikes || 0)), 1);
              const total = (d.likes || 0) + (d.dislikes || 0);
              const h = Math.max(2, (total / max) * 100);
              const likeH = total > 0 ? (d.likes / total) * h : 0;
              return (
                <div key={i} className="flex-1 flex flex-col justify-end items-center gap-0" title={`${d.date}: ${d.likes}L ${d.dislikes}D ${d.active_users}U`}>
                  <div className="w-full rounded-t" style={{ height: likeH + "%", background: "#34C759", minHeight: likeH > 0 ? 1 : 0 }} />
                  <div className="w-full" style={{ height: (h - likeH) + "%", background: "#E5E5EA", minHeight: total > 0 ? 1 : 0 }} />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between mt-2 text-[0.611rem] text-text3">
            <span>{daily[0]?.date?.slice(5)}</span>
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-success" />Likes</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-border" />Skips</span>
            </span>
            <span>{daily[daily.length - 1]?.date?.slice(5)}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Popular keywords */}
          <div className="bg-card rounded-xl border border-border p-4" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
            <h2 className="text-[0.889rem] font-semibold text-text1 mb-3">Popular Keywords</h2>
            <div className="flex flex-wrap gap-1.5">
              {keywords.map((k, i) => (
                <span key={i} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-[0.722rem] font-medium bg-hover border border-border text-text2">
                  {k.keyword} <span className="text-text3">{k.user_count}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Journal distribution */}
          <div className="bg-card rounded-xl border border-border p-4" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
            <h2 className="text-[0.889rem] font-semibold text-text1 mb-3">Journals</h2>
            <div className="space-y-1.5 max-h-[240px] overflow-y-auto">
              {journals.map((j, i) => (
                <div key={i} className="flex items-center justify-between text-[0.778rem]">
                  <span className="text-text2 truncate flex-1 mr-2">{j.journal}</span>
                  <span className="text-text3 font-mono shrink-0">{j.paper_count}</span>
                  {j.recent_count > 0 && <span className="text-accent text-[0.667rem] ml-1 shrink-0">+{j.recent_count}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Top liked papers */}
        <div className="bg-card rounded-xl border border-border p-4 sm:p-5 mb-6" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
          <h2 className="text-[0.889rem] font-semibold text-text1 mb-3">Most Liked Papers</h2>
          <div className="space-y-2">
            {topPapers.map((p, i) => (
              <div key={i} className="flex items-start gap-3 p-2 rounded-lg hover:bg-hover">
                <span className="text-[0.778rem] font-bold text-accent shrink-0 w-5 text-right">{p.like_count}</span>
                <div className="min-w-0">
                  <p className="text-[0.778rem] font-medium text-text1 leading-snug">{p.title}</p>
                  <p className="text-[0.667rem] text-text3 mt-0.5">{p.journal} · {p.pub_date}</p>
                </div>
              </div>
            ))}
            {!topPapers.length && <p className="text-text3 text-[0.833rem] text-center py-4">No likes yet</p>}
          </div>
        </div>

        {/* User engagement */}
        <div className="bg-card rounded-xl border border-border p-4 sm:p-5" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
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
                    <td className="py-2 text-right text-text3">{u.last_active ? new Date(u.last_active).toLocaleDateString() : "—"}</td>
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
