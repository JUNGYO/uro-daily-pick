import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import { Loader2, TrendingUp, BookOpen, Zap } from "lucide-react";

const STOP = new Set(["humans","male","female","aged","middle aged","aged, 80 and over","adult","young adult","adolescent","child","animals","treatment outcome","follow-up studies","time factors","prognosis","risk factors","retrospective studies","prospective studies","cohort studies","prevalence","incidence","survival rate","survival analysis","proportional hazards models","multivariate analysis","logistic models","predictive value of tests","sensitivity and specificity","reproducibility of results","reference values","risk assessment","united states","europe","japan","korea","china","journal article","research support","english abstract","comparative study","multicenter study","randomized controlled trial","evaluation study","clinical trial","practice guideline","meta-analysis","systematic review","review","case reports","editorial","letter","comment"]);

const COLORS = ["#007AFF","#34C759","#FF9500","#AF52DE","#FF3B30","#00C7BE","#5856D6","#FF2D55","#30B0C7","#A2845E","#636366","#48484A"];
const TYPE_LABELS = { rct:"Clinical Trial", basic_research:"Basic Research", biomarker:"Biomarker", retrospective:"Retrospective", prospective:"Prospective", meta_analysis:"Meta-analysis", ai_ml:"AI / ML", surgical:"Surgical", imaging:"Imaging", epidemiology:"Epidemiology", guideline:"Guideline", review:"Review" };
const HEAT = ["#F5F5F7","#DBEAFE","#93C5FD","#3B82F6","#1D4ED8","#1E3A5F"];

/* ═══ Heatmap ═══ */
function Heatmap({ readDates }) {
  const weeks = 26;
  const today = new Date();
  const cells = [];
  for (let w = weeks - 1; w >= 0; w--) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(today); date.setDate(date.getDate() - (w * 7 + (6 - d)));
      const key = date.toISOString().slice(0, 10);
      cells.push({ date: key, count: readDates[key] || 0 });
    }
  }
  const months = []; let lastM = "";
  cells.forEach((c, i) => {
    const m = new Date(c.date).toLocaleDateString("en-US", { month: "short" });
    if (m !== lastM) { months.push({ label: m, col: Math.floor(i / 7) }); lastM = m; }
  });

  return (
    <div className="overflow-x-auto pb-2">
      <div className="inline-block min-w-[400px]">
        <div className="flex mb-1 ml-7" style={{ gap: 2 }}>
          {Array.from({ length: weeks }, (_, w) => {
            const m = months.find(m => m.col === w);
            return <div key={w} style={{ width: 12, fontSize: 9 }} className="text-text3 text-center">{m?.label || ""}</div>;
          })}
        </div>
        <div className="flex">
          <div className="flex flex-col mr-1" style={{ gap: 2 }}>
            {["","M","","W","","F",""].map((d, i) => (
              <div key={i} style={{ width: 22, height: 12, fontSize: 9, lineHeight: "12px" }} className="text-text3 text-right pr-1">{d}</div>
            ))}
          </div>
          <div className="grid" style={{ gridTemplateRows: "repeat(7, 12px)", gridAutoFlow: "column", gap: 2 }}>
            {cells.map((c, i) => (
              <div key={i} title={`${c.date}: ${c.count} papers`}
                className="rounded-sm hover:ring-1 hover:ring-accent hover:ring-offset-1 transition-all"
                style={{ width: 12, height: 12, background: HEAT[Math.min(5, c.count)], cursor: "pointer" }} />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1 mt-2 ml-7">
          <span style={{ fontSize: 9 }} className="text-text3 mr-1">Less</span>
          {HEAT.map((c, i) => <div key={i} className="rounded-sm" style={{ width: 10, height: 10, background: c }} />)}
          <span style={{ fontSize: 9 }} className="text-text3 ml-1">More</span>
        </div>
      </div>
    </div>
  );
}

/* ═══ Topic Bars (replaces treemap — works on all screens) ═══ */
function TopicBars({ data }) {
  const max = data[0]?.value || 1;
  return (
    <div className="space-y-2">
      {data.map((d, i) => (
        <div key={d.name} className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[0.778rem] text-text1 truncate">{d.name}</span>
              <span className="text-[0.667rem] text-text3 font-mono ml-2 shrink-0">{d.value}</span>
            </div>
            <div className="h-3 bg-hover rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700"
                style={{ width: `${(d.value / max) * 100}%`, background: COLORS[i % COLORS.length] }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ═══ Activity Ring ═══ */
function Ring({ value, max, color, label, icon: Icon }) {
  const r = 34, circ = 2 * Math.PI * r, pct = Math.min(1, value / Math.max(1, max));
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="84" height="84" viewBox="0 0 84 84">
        <circle cx="42" cy="42" r={r} fill="none" stroke="#F2F2F7" strokeWidth="6" />
        <circle cx="42" cy="42" r={r} fill="none" stroke={color} strokeWidth="6"
          strokeDasharray={`${pct * circ} ${circ}`} strokeLinecap="round"
          transform="rotate(-90 42 42)" style={{ transition: "stroke-dasharray 1s ease" }} />
        <text x="42" y="39" textAnchor="middle" fontSize="16" fontWeight="700" fill="#1D1D1F">{value}</text>
        <text x="42" y="52" textAnchor="middle" fontSize="8" fill="#86868B">/ {max}</text>
      </svg>
      <div className="flex items-center gap-1">
        <Icon size={11} style={{ color }} />
        <span className="text-[0.667rem] text-text3 font-medium">{label}</span>
      </div>
    </div>
  );
}

/* ═══ Main ═══ */
export default function Insights() {
  const { user } = useAuth();
  const [papers, setPapers] = useState([]);
  const [readDates, setReadDates] = useState({});
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, liked: 0, streak: 0 });

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: fbs } = await supabase.from("feedbacks").select("paper_id").eq("user_id", user.id).eq("action", "like");
      const { data: reads } = await supabase.from("read_history").select("paper_id,clicked_at").eq("user_id", user.id);
      const paperIds = [...new Set([...(fbs || []).map(f => f.paper_id), ...(reads || []).map(r => r.paper_id)])];

      const dateCounts = {};
      for (const r of (reads || [])) { const d = r.clicked_at?.slice(0, 10); if (d) dateCounts[d] = (dateCounts[d] || 0) + 1; }
      setReadDates(dateCounts);

      if (paperIds.length) {
        const { data } = await supabase.from("papers").select("id,keywords,mesh_terms,study_type,journal").in("id", paperIds);
        setPapers(data || []);
      }

      let streak = 0; const today = new Date();
      for (let i = 0; i < 365; i++) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        if (dateCounts[d.toISOString().slice(0, 10)]) streak++; else break;
      }
      setStats({ total: paperIds.length, liked: (fbs || []).length, streak });
      setLoading(false);
    })();
  }, [user]);

  if (loading) return (
    <div className="flex items-center justify-center" style={{ height: "calc(100vh - 56px)" }}>
      <Loader2 size={32} className="text-accent animate-spin" />
    </div>
  );

  // Topic data
  const kwCount = {};
  for (const p of papers) {
    for (const k of (p.keywords || [])) { const kl = k.toLowerCase(); if (!STOP.has(kl) && kl.length > 2 && kl.length < 40) kwCount[kl] = (kwCount[kl] || 0) + 1; }
    for (const m of (p.mesh_terms || [])) { const ml = m.toLowerCase(); if (!STOP.has(ml) && ml.length > 2 && ml.length < 40) kwCount[ml] = (kwCount[ml] || 0) + 1; }
  }
  const topicData = Object.entries(kwCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, value]) => ({ name, value }));

  // Study types
  const typeCounts = {};
  for (const p of papers) { const t = p.study_type || "other"; typeCounts[t] = (typeCounts[t] || 0) + 1; }
  const typeData = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxType = typeData[0]?.[1] || 1;

  // Insight
  const topKws = topicData.slice(0, 2).map(d => d.name);
  const topType = typeData[0];
  const journals = {}; papers.forEach(p => { if (p.journal) journals[p.journal] = (journals[p.journal] || 0) + 1; });
  const topJ = Object.entries(journals).sort((a, b) => b[1] - a[1])[0];

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-[800px] mx-auto">

        <h1 className="text-[1.111rem] font-bold text-text1 mb-5">Research Insights</h1>

        {/* Rings */}
        <div className="bg-card rounded-xl border border-border p-4 mb-4 flex items-center justify-around" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
          <Ring value={stats.total} max={50} color="#007AFF" label="Read" icon={BookOpen} />
          <Ring value={stats.liked} max={20} color="#34C759" label="Liked" icon={TrendingUp} />
          <Ring value={stats.streak} max={30} color="#FF9500" label="Streak" icon={Zap} />
        </div>

        {/* Insight */}
        {topKws.length >= 2 && (
          <div className="bg-[rgba(0,122,255,0.04)] border border-[rgba(0,122,255,0.1)] rounded-xl p-4 mb-4">
            <p className="text-[0.833rem] text-text1 leading-relaxed">
              Your reading is centered on <strong>{topKws[0]}</strong> and <strong>{topKws[1]}</strong>.
              {topType && ` ${Math.round(topType[1] / papers.length * 100)}% are ${TYPE_LABELS[topType[0]] || topType[0]}.`}
              {topJ && ` Most read: ${topJ[0]} (${topJ[1]}).`}
            </p>
          </div>
        )}

        {/* Heatmap */}
        <div className="bg-card rounded-xl border border-border p-4 mb-4" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
          <h2 className="text-[0.833rem] font-semibold text-text1 mb-3">Reading Activity</h2>
          <Heatmap readDates={readDates} />
        </div>

        {/* Topics + Study Types */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-card rounded-xl border border-border p-4" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
            <h2 className="text-[0.833rem] font-semibold text-text1 mb-3">Top Keywords</h2>
            {topicData.length >= 3 ? <TopicBars data={topicData} /> : <p className="text-[0.778rem] text-text3 text-center py-4">Read more papers</p>}
          </div>

          <div className="bg-card rounded-xl border border-border p-4" style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
            <h2 className="text-[0.833rem] font-semibold text-text1 mb-3">Study Types</h2>
            <div className="space-y-2.5">
              {typeData.map(([type, count], i) => (
                <div key={type}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[0.778rem] text-text2">{TYPE_LABELS[type] || type}</span>
                    <span className="text-[0.667rem] text-text3 font-mono">{count}</span>
                  </div>
                  <div className="h-2.5 bg-hover rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700" style={{
                      width: `${(count / maxType) * 100}%`, background: COLORS[i % COLORS.length],
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
