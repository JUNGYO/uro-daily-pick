import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import * as d3 from "d3";
import { Loader2, TrendingUp, BookOpen, Zap } from "lucide-react";

// Filter out generic MeSH
const STOP = new Set(["humans","male","female","aged","middle aged","aged, 80 and over","adult","young adult","adolescent","child","animals","treatment outcome","follow-up studies","time factors","prognosis","risk factors","retrospective studies","prospective studies","cohort studies","prevalence","incidence","survival rate","survival analysis","proportional hazards models","multivariate analysis","logistic models","predictive value of tests","sensitivity and specificity","reproducibility of results","reference values","risk assessment","united states","europe","japan","korea","china","journal article","research support","english abstract","comparative study","multicenter study","randomized controlled trial","evaluation study","clinical trial","practice guideline","meta-analysis","systematic review","review","case reports","editorial","letter","comment"]);

const TOPIC_COLORS = ["#007AFF","#34C759","#FF9500","#AF52DE","#FF3B30","#00C7BE","#5856D6","#FF2D55","#8E8E93","#30B0C7","#A2845E","#636366","#48484A","#007AFF","#34C759"];
const TYPE_LABELS = { rct:"Clinical Trial", basic_research:"Basic Research", biomarker:"Biomarker", retrospective:"Retrospective", prospective:"Prospective", meta_analysis:"Meta-analysis", ai_ml:"AI / ML", surgical:"Surgical", imaging:"Imaging", epidemiology:"Epidemiology", guideline:"Guideline", review:"Review" };

const HEAT_COLORS = ["#F5F5F7","#DBEAFE","#93C5FD","#3B82F6","#1D4ED8","#1E3A5F"];

/* ═══ Heatmap (GitHub 잔디) ═══ */
function Heatmap({ readDates }) {
  const weeks = 26;
  const today = new Date();
  const cells = [];

  for (let w = weeks - 1; w >= 0; w--) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(today);
      date.setDate(date.getDate() - (w * 7 + (6 - d)));
      const key = date.toISOString().slice(0, 10);
      const count = readDates[key] || 0;
      cells.push({ date: key, count, dayOfWeek: date.getDay(), weekAgo: w });
    }
  }

  const months = [];
  let lastMonth = "";
  cells.forEach((c, i) => {
    const m = new Date(c.date).toLocaleDateString("en-US", { month: "short" });
    if (m !== lastMonth) { months.push({ label: m, x: Math.floor(i / 7) }); lastMonth = m; }
  });

  return (
    <div className="overflow-x-auto">
      <div className="inline-block">
        {/* Month labels */}
        <div className="flex mb-1 ml-8" style={{ gap: 2 }}>
          {Array.from({ length: weeks }, (_, w) => {
            const m = months.find(m => m.x === weeks - 1 - w);
            return <div key={w} className="text-[9px] text-text3" style={{ width: 14, textAlign: "center" }}>{m?.label || ""}</div>;
          })}
        </div>
        <div className="flex">
          {/* Day labels */}
          <div className="flex flex-col mr-1" style={{ gap: 2 }}>
            {["","M","","W","","F",""].map((d, i) => (
              <div key={i} className="text-[9px] text-text3 flex items-center justify-end" style={{ width: 24, height: 14 }}>{d}</div>
            ))}
          </div>
          {/* Grid */}
          <div className="grid" style={{ gridTemplateRows: "repeat(7, 14px)", gridAutoFlow: "column", gap: 2 }}>
            {cells.map((c, i) => {
              const level = c.count === 0 ? 0 : Math.min(5, c.count);
              return (
                <div key={i} title={`${c.date}: ${c.count} papers`}
                  className="rounded-[3px] transition-transform hover:scale-[1.4]"
                  style={{ width: 14, height: 14, background: HEAT_COLORS[level], cursor: "pointer" }} />
              );
            })}
          </div>
        </div>
        {/* Legend */}
        <div className="flex items-center gap-1 mt-2 ml-8">
          <span className="text-[9px] text-text3 mr-1">Less</span>
          {HEAT_COLORS.map((c, i) => <div key={i} className="rounded-[2px]" style={{ width: 10, height: 10, background: c }} />)}
          <span className="text-[9px] text-text3 ml-1">More</span>
        </div>
      </div>
    </div>
  );
}

/* ═══ Treemap ═══ */
function Treemap({ data, width, height }) {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!data.length || !width) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const root = d3.hierarchy({ children: data }).sum(d => d.value).sort((a, b) => b.value - a.value);
    d3.treemap().size([width, height]).padding(3).round(true)(root);

    const g = svg.append("g");

    const leaf = g.selectAll("g").data(root.leaves()).join("g")
      .attr("transform", d => `translate(${d.x0},${d.y0})`);

    // Rect with rounded corners
    leaf.append("rect")
      .attr("width", d => Math.max(0, d.x1 - d.x0))
      .attr("height", d => Math.max(0, d.y1 - d.y0))
      .attr("rx", 6)
      .attr("fill", (d, i) => TOPIC_COLORS[i % TOPIC_COLORS.length])
      .attr("fill-opacity", 0.85)
      .style("cursor", "pointer")
      .on("mouseover", function() { d3.select(this).attr("fill-opacity", 1); })
      .on("mouseout", function() { d3.select(this).attr("fill-opacity", 0.85); });

    // Label (only if rect is big enough)
    leaf.filter(d => (d.x1 - d.x0) > 50 && (d.y1 - d.y0) > 25)
      .append("text")
      .attr("x", 8).attr("y", 18)
      .text(d => d.data.name.length > 20 ? d.data.name.slice(0, 18) + "…" : d.data.name)
      .attr("font-size", d => Math.min(13, Math.max(10, (d.x1 - d.x0) / 8)))
      .attr("fill", "#FFF")
      .attr("font-weight", "600")
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("pointer-events", "none");

    // Count
    leaf.filter(d => (d.x1 - d.x0) > 50 && (d.y1 - d.y0) > 40)
      .append("text")
      .attr("x", 8).attr("y", 34)
      .text(d => `${d.data.value} papers`)
      .attr("font-size", 10)
      .attr("fill", "rgba(255,255,255,0.7)")
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("pointer-events", "none");

  }, [data, width, height]);

  return <svg ref={svgRef} width={width} height={height} />;
}

/* ═══ Activity Ring ═══ */
function Ring({ value, max, color, label, icon: Icon }) {
  const r = 38;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(1, value / Math.max(1, max));

  return (
    <div className="flex flex-col items-center">
      <svg width="100" height="100" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#F2F2F7" strokeWidth="7" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="7"
          strokeDasharray={`${pct * circ} ${circ}`} strokeLinecap="round"
          transform="rotate(-90 50 50)" className="transition-all duration-700" />
        <text x="50" y="46" textAnchor="middle" fontSize="18" fontWeight="700" fill="#1D1D1F">{value}</text>
        <text x="50" y="60" textAnchor="middle" fontSize="9" fill="#86868B">/ {max}</text>
      </svg>
      <div className="flex items-center gap-1 mt-1">
        <Icon size={12} style={{ color }} />
        <span className="text-[0.722rem] text-text3 font-medium">{label}</span>
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
  const treemapRef = useRef(null);
  const [treemapW, setTreemapW] = useState(600);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: fbs } = await supabase.from("feedbacks").select("paper_id").eq("user_id", user.id).eq("action", "like");
      const { data: reads } = await supabase.from("read_history").select("paper_id,clicked_at").eq("user_id", user.id);

      const paperIds = [...new Set([...(fbs || []).map(f => f.paper_id), ...(reads || []).map(r => r.paper_id)])];

      // Date counts for heatmap
      const dateCounts = {};
      for (const r of (reads || [])) {
        const d = r.clicked_at?.slice(0, 10);
        if (d) dateCounts[d] = (dateCounts[d] || 0) + 1;
      }
      // Also count feedback dates
      setReadDates(dateCounts);

      if (paperIds.length) {
        const { data } = await supabase.from("papers").select("id,keywords,mesh_terms,study_type,journal").in("id", paperIds);
        setPapers(data || []);
      }

      // Streak
      let streak = 0;
      const today = new Date();
      for (let i = 0; i < 365; i++) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        if (dateCounts[key]) streak++; else break;
      }

      setStats({ total: paperIds.length, liked: (fbs || []).length, streak });
      setLoading(false);
    })();
  }, [user]);

  useEffect(() => {
    const resize = () => { if (treemapRef.current) setTreemapW(treemapRef.current.offsetWidth); };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center" style={{ height: "calc(100vh - 56px)" }}>
      <Loader2 size={32} className="text-accent animate-spin" />
    </div>
  );

  // Topic data for treemap
  const kwCount = {};
  for (const p of papers) {
    for (const k of (p.keywords || [])) { const kl = k.toLowerCase(); if (!STOP.has(kl) && kl.length > 2) kwCount[kl] = (kwCount[kl] || 0) + 1; }
    for (const m of (p.mesh_terms || [])) { const ml = m.toLowerCase(); if (!STOP.has(ml) && ml.length > 2) kwCount[ml] = (kwCount[ml] || 0) + 1; }
  }
  const treemapData = Object.entries(kwCount).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, value]) => ({ name, value }));

  // Study type distribution
  const typeCounts = {};
  for (const p of papers) { const t = p.study_type || "other"; typeCounts[t] = (typeCounts[t] || 0) + 1; }
  const typeEntries = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxType = typeEntries[0]?.[1] || 1;

  // Insight text
  const topKws = treemapData.slice(0, 2).map(d => d.name);
  const topType = typeEntries[0];
  const topJournal = (() => { const j = {}; papers.forEach(p => { if (p.journal) j[p.journal] = (j[p.journal] || 0) + 1; }); return Object.entries(j).sort((a, b) => b[1] - a[1])[0]; })();

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 sm:p-6 lg:p-8 max-w-[1000px] mx-auto">

        {/* Header */}
        <h1 className="text-[1.222rem] font-bold text-text1 mb-6">Research Insights</h1>

        {/* Activity Rings + Stats */}
        <div className="bg-card rounded-xl border border-border p-5 mb-4 flex flex-col sm:flex-row items-center justify-around gap-6" style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
          <Ring value={stats.total} max={50} color="#007AFF" label="Papers Read" icon={BookOpen} />
          <Ring value={stats.liked} max={20} color="#34C759" label="Liked" icon={TrendingUp} />
          <Ring value={stats.streak} max={30} color="#FF9500" label="Day Streak" icon={Zap} />
        </div>

        {/* Insight text */}
        {topKws.length >= 2 && (
          <div className="bg-[rgba(0,122,255,0.04)] border border-[rgba(0,122,255,0.1)] rounded-xl p-4 mb-4">
            <p className="text-[0.889rem] text-text1 leading-relaxed">
              Your reading is centered on <strong>{topKws[0]}</strong> and <strong>{topKws[1]}</strong>.
              {topType && ` ${Math.round(topType[1] / papers.length * 100)}% are ${TYPE_LABELS[topType[0]] || topType[0]}.`}
              {topJournal && ` Most read: ${topJournal[0]} (${topJournal[1]}).`}
            </p>
          </div>
        )}

        {/* Heatmap */}
        <div className="bg-card rounded-xl border border-border p-5 mb-4" style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
          <h2 className="text-[0.889rem] font-semibold text-text1 mb-3">Reading Activity</h2>
          <Heatmap readDates={readDates} />
        </div>

        {/* Treemap + Study Types */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-3 bg-card rounded-xl border border-border p-5" ref={treemapRef} style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
            <h2 className="text-[0.889rem] font-semibold text-text1 mb-3">Research Topics</h2>
            {treemapData.length >= 3 ? (
              <Treemap data={treemapData} width={treemapW - 40} height={280} />
            ) : (
              <p className="text-[0.833rem] text-text3 py-8 text-center">Read more papers to see topic distribution.</p>
            )}
          </div>

          <div className="lg:col-span-2 bg-card rounded-xl border border-border p-5" style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
            <h2 className="text-[0.889rem] font-semibold text-text1 mb-4">Study Types</h2>
            <div className="space-y-3">
              {typeEntries.map(([type, count], i) => (
                <div key={type}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[0.778rem] text-text2">{TYPE_LABELS[type] || type}</span>
                    <span className="text-[0.722rem] text-text3 font-mono">{count}</span>
                  </div>
                  <div className="h-2 bg-hover rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500" style={{
                      width: `${(count / maxType) * 100}%`,
                      background: TOPIC_COLORS[i % TOPIC_COLORS.length],
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
