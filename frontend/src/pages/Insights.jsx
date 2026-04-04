import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import { Loader2, TrendingUp, BookOpen, Zap } from "lucide-react";

const STOP = new Set(["humans","male","female","aged","middle aged","aged, 80 and over","adult","young adult","adolescent","child","animals","treatment outcome","follow-up studies","time factors","prognosis","risk factors","retrospective studies","prospective studies","cohort studies","prevalence","incidence","survival rate","survival analysis","proportional hazards models","multivariate analysis","logistic models","predictive value of tests","sensitivity and specificity","reproducibility of results","reference values","risk assessment","united states","europe","japan","korea","china","journal article","research support","english abstract","comparative study","multicenter study","randomized controlled trial","evaluation study","clinical trial","practice guideline","meta-analysis","systematic review","review","case reports","editorial","letter","comment"]);
const COLORS = ["#007AFF","#34C759","#FF9500","#AF52DE","#FF3B30","#00C7BE","#5856D6","#FF2D55","#30B0C7","#A2845E","#636366","#48484A"];
const TYPE_LABELS = {rct:"Clinical Trial",basic_research:"Basic Research",biomarker:"Biomarker",retrospective:"Retrospective",prospective:"Prospective",meta_analysis:"Meta-analysis",ai_ml:"AI / ML",surgical:"Surgical",imaging:"Imaging",epidemiology:"Epidemiology",guideline:"Guideline",review:"Review"};
const HEAT = ["#F5F5F7","#DBEAFE","#93C5FD","#3B82F6","#1D4ED8","#1E3A5F"];

function Ring({value, max, color, label, icon: Icon}) {
  var r = 34, circ = 2 * Math.PI * r, pct = Math.min(1, value / Math.max(1, max));
  return (
    <div className="flex flex-col items-center gap-1">
      <svg className="w-[68px] h-[68px] sm:w-[84px] sm:h-[84px]" viewBox="0 0 84 84">
        <circle cx="42" cy="42" r={r} fill="none" stroke="#F2F2F7" strokeWidth="6" />
        <circle cx="42" cy="42" r={r} fill="none" stroke={color} strokeWidth="6" strokeDasharray={pct*circ + " " + circ} strokeLinecap="round" transform="rotate(-90 42 42)" />
        <text x="42" y="39" textAnchor="middle" fontSize="16" fontWeight="700" fill="#1D1D1F">{value}</text>
        <text x="42" y="52" textAnchor="middle" fontSize="8" fill="#86868B">{"/ " + max}</text>
      </svg>
      <div className="flex items-center gap-1">
        <Icon size={11} style={{color: color}} />
        <span className="text-[0.667rem] text-text3 font-medium">{label}</span>
      </div>
    </div>
  );
}

function HeatmapTable({ weeks, heatCells, heatMonths }) {
  var days = [
    {label:"M",color:"#86868B"},{label:"T",color:"#86868B"},{label:"W",color:"#86868B"},
    {label:"T",color:"#86868B"},{label:"F",color:"#86868B"},{label:"S",color:"#007AFF"},{label:"S",color:"#FF3B30"}
  ];

  // Single grid: col 0 = day labels, cols 1..weeks = data
  // Row 0 = month labels, rows 1..7 = data
  var cols = weeks + 1; // +1 for day label column
  var rows = 8; // 1 month row + 7 day rows

  // Build month header cells with correct colSpan via gridColumn
  var monthCells = [];
  var col = 2; // start after day-label column (grid is 1-indexed)
  heatMonths.forEach(function(m) {
    monthCells.push({ label: m.label, colStart: col, colEnd: col + m.span });
    col += m.span;
  });

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "16px repeat(" + weeks + ", 1fr)",
      gridTemplateRows: "auto repeat(7, 1fr)",
      gap: 2,
      width: "100%",
    }}>
      {/* Row 0, Col 0: empty corner */}
      <div />
      {/* Row 0: month labels */}
      {monthCells.map(function(m, i) {
        return <div key={i} className="text-text3" style={{
          gridColumn: m.colStart + " / " + m.colEnd,
          gridRow: 1,
          fontSize: 10,
          lineHeight: "16px",
        }}>{m.label}</div>;
      })}
      {/* Rows 1-7: day labels + cells */}
      {days.flatMap(function(d, row) {
        var items = [];
        // Day label
        items.push(
          <div key={"label-"+row} style={{
            gridColumn: 1, gridRow: row + 2,
            fontSize: 10, fontWeight: 600, color: d.color,
            display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 2,
          }}>{d.label}</div>
        );
        // Cells for this day across all weeks
        for (var w = 0; w < weeks; w++) {
          var cell = heatCells[w * 7 + row];
          items.push(
            <div key={"c-"+row+"-"+w} title={cell ? cell.date + ": " + cell.count + " papers" : ""}
              className="rounded-sm hover:ring-2 hover:ring-accent hover:ring-offset-1"
              style={{
                gridColumn: w + 2, gridRow: row + 2,
                background: cell ? HEAT[Math.min(5, cell.count)] : "#F5F5F7",
                cursor: "pointer", aspectRatio: "1",
              }} />
          );
        }
        return items;
      })}
    </div>
  );
}

export default function Insights() {
  var auth = useAuth(), user = auth.user;
  var _p = useState([]), papers = _p[0], setPapers = _p[1];
  var _d = useState({}), readDates = _d[0], setReadDates = _d[1];
  var _l = useState(true), loading = _l[0], setLoading = _l[1];
  var _s = useState({total:0,liked:0,streak:0}), stats = _s[0], setStats = _s[1];

  useEffect(function() {
    if (!user) return;
    (async function() {
      var fbRes = await supabase.from("feedbacks").select("paper_id").eq("user_id", user.id).eq("action", "like");
      var readRes = await supabase.from("read_history").select("paper_id,clicked_at").eq("user_id", user.id);
      var fbs = fbRes.data || [], reads = readRes.data || [];
      var paperIds = Array.from(new Set(fbs.map(function(f){return f.paper_id}).concat(reads.map(function(r){return r.paper_id}))));
      var dateCounts = {};
      reads.forEach(function(r) { var d = (r.clicked_at||"").slice(0,10); if(d) dateCounts[d] = (dateCounts[d]||0)+1; });
      setReadDates(dateCounts);
      if (paperIds.length) {
        var pRes = await supabase.from("papers").select("id,keywords,mesh_terms,study_type,journal").in("id", paperIds);
        setPapers(pRes.data || []);
      }
      var streak = 0, today = new Date();
      for (var i = 0; i < 365; i++) {
        var dd = new Date(today); dd.setDate(dd.getDate() - i);
        if (dateCounts[dd.toISOString().slice(0,10)]) streak++; else break;
      }
      setStats({total: paperIds.length, liked: fbs.length, streak: streak});
      setLoading(false);
    })();
  }, [user]);

  if (loading) return (
    <div className="flex items-center justify-center" style={{height:"calc(100vh - 56px)"}}>
      <Loader2 size={32} className="text-accent animate-spin" />
    </div>
  );

  // Topic data
  var kwCount = {};
  papers.forEach(function(p) {
    var kws = Array.isArray(p.keywords) ? p.keywords : [];
    var mesh = Array.isArray(p.mesh_terms) ? p.mesh_terms : [];
    try { if (typeof p.keywords === "string") kws = JSON.parse(p.keywords); } catch(e) {}
    try { if (typeof p.mesh_terms === "string") mesh = JSON.parse(p.mesh_terms); } catch(e) {}
    kws.forEach(function(k) { var kl=k.toLowerCase(); if(!STOP.has(kl)&&kl.length>2&&kl.length<40) kwCount[kl]=(kwCount[kl]||0)+1; });
    mesh.forEach(function(m) { var ml=m.toLowerCase(); if(!STOP.has(ml)&&ml.length>2&&ml.length<40) kwCount[ml]=(kwCount[ml]||0)+1; });
  });
  var topicData = Object.entries(kwCount).sort(function(a,b){return b[1]-a[1]}).slice(0,10);
  var topicTotal = topicData.reduce(function(s,d){return s+d[1]},0) || 1;

  // Study types
  var typeCounts = {};
  papers.forEach(function(p) { var t=p.study_type||"other"; typeCounts[t]=(typeCounts[t]||0)+1; });
  var typeData = Object.entries(typeCounts).sort(function(a,b){return b[1]-a[1]}).slice(0,6);
  var maxType = typeData[0] ? typeData[0][1] : 1;

  // Heatmap data — responsive weeks (13 on mobile, 26 on desktop)
  var isMobile = typeof window !== "undefined" && window.innerWidth < 640;
  var weeks = isMobile ? 13 : 26, today = new Date(), heatCells = [];
  for (var w = weeks-1; w >= 0; w--) {
    for (var d = 0; d < 7; d++) {
      var date = new Date(today); date.setDate(date.getDate() - (w*7 + (6-d)));
      var key = date.toISOString().slice(0,10);
      heatCells.push({date: key, count: readDates[key]||0});
    }
  }
  // Month labels for heatmap
  var heatMonths = [];
  var lastMonth = "";
  for (var wi = 0; wi < weeks; wi++) {
    var cellDate = new Date(today);
    cellDate.setDate(cellDate.getDate() - ((weeks-1-wi)*7));
    var mon = cellDate.toLocaleDateString("en-US",{month:"short"});
    if (mon !== lastMonth) {
      if (heatMonths.length) heatMonths[heatMonths.length-1].span = wi - heatMonths[heatMonths.length-1].start;
      heatMonths.push({label:mon, start:wi, span:1});
      lastMonth = mon;
    }
  }
  if (heatMonths.length) heatMonths[heatMonths.length-1].span = weeks - heatMonths[heatMonths.length-1].start;

  // Insight
  var topKws = topicData.slice(0,2).map(function(d){return d[0]});
  var topType = typeData[0];
  var journals = {}; papers.forEach(function(p){if(p.journal) journals[p.journal]=(journals[p.journal]||0)+1;});
  var topJ = Object.entries(journals).sort(function(a,b){return b[1]-a[1]})[0];

  if (!stats.total && !loading) return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-[800px] mx-auto">
        <h1 className="text-[1.111rem] font-bold text-text1 mb-5">Research Insights</h1>
        <div className="flex flex-col items-center py-16">
          <div className="w-20 h-20 rounded-2xl bg-hover flex items-center justify-center mb-4">
            <BookOpen size={32} className="text-text3" />
          </div>
          <p className="text-[1.111rem] font-semibold text-text1 mb-2">No data yet</p>
          <p className="text-[0.889rem] text-text3 text-center max-w-xs leading-relaxed">
            Start reading and liking papers in Daily Pick. Your insights will appear here.
          </p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-[800px] mx-auto">
        <h1 className="text-[1.111rem] font-bold text-text1 mb-5">Research Insights</h1>

        <div className="bg-card rounded-xl border border-border p-4 mb-4 flex items-center justify-around" style={{boxShadow:"0 1px 3px rgba(0,0,0,0.03)"}}>
          <Ring value={stats.total} max={50} color="#007AFF" label="Read" icon={BookOpen} />
          <Ring value={stats.liked} max={20} color="#34C759" label="Liked" icon={TrendingUp} />
          <Ring value={stats.streak} max={30} color="#FF9500" label="Streak" icon={Zap} />
        </div>

        {topKws.length >= 2 && (
          <div className="bg-[rgba(0,122,255,0.04)] border border-[rgba(0,122,255,0.1)] rounded-xl p-4 mb-4">
            <p className="text-[0.833rem] text-text1 leading-relaxed">
              Your reading is centered on <strong>{topKws[0]}</strong> and <strong>{topKws[1]}</strong>.
              {topType && papers.length ? " " + Math.round(topType[1]/papers.length*100) + "% are " + (TYPE_LABELS[topType[0]]||topType[0]) + "." : ""}
              {topJ ? " Most read: " + topJ[0] + " (" + topJ[1] + ")." : ""}
            </p>
          </div>
        )}

        <div className="bg-card rounded-xl border border-border p-4 sm:p-5 mb-4" style={{boxShadow:"0 1px 3px rgba(0,0,0,0.03)"}}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[0.833rem] font-semibold text-text1">Reading Activity</h2>
            <div className="flex items-center gap-1.5">
              <span className="text-[0.667rem] text-text3">Less</span>
              {HEAT.map(function(c,i){return <div key={i} className="rounded-sm" style={{width:11,height:11,background:c}} />;})}
              <span className="text-[0.667rem] text-text3">More</span>
            </div>
          </div>
          <HeatmapTable weeks={weeks} heatCells={heatCells} heatMonths={heatMonths} />
        </div>

        <div className="bg-card rounded-xl border border-border p-4 mb-4" style={{boxShadow:"0 1px 3px rgba(0,0,0,0.03)"}}>
          <h2 className="text-[0.833rem] font-semibold text-text1 mb-3">Research Topics</h2>
          <div className="flex flex-wrap gap-1" style={{minHeight:120}}>
            {topicData.map(function(d,i) {
              var pct = d[1] / topicTotal;
              return (
                <div key={d[0]} className="rounded-lg flex flex-col justify-end p-2.5" style={{flex:"1 1 " + Math.max(28,pct*250) + "%",minWidth:70,minHeight:45,background:COLORS[i%COLORS.length]}}>
                  <span className="text-white font-semibold" style={{fontSize:pct>0.15?13:11,lineHeight:"1.2"}}>{d[0].length>20?d[0].slice(0,18)+"...":d[0]}</span>
                  <span className="text-white/70" style={{fontSize:10}}>{d[1]}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-4" style={{boxShadow:"0 1px 3px rgba(0,0,0,0.03)"}}>
          <h2 className="text-[0.833rem] font-semibold text-text1 mb-3">Study Types</h2>
          <div className="space-y-2.5">
            {typeData.map(function(entry,i) {
              return (
                <div key={entry[0]}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[0.778rem] text-text2">{TYPE_LABELS[entry[0]]||entry[0]}</span>
                    <span className="text-[0.667rem] text-text3 font-mono">{entry[1]}</span>
                  </div>
                  <div className="h-2.5 bg-hover rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{width:(entry[1]/maxType*100)+"%",background:COLORS[i%COLORS.length],transition:"width 0.7s"}} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
