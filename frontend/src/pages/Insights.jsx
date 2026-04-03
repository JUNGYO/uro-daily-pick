import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import * as d3 from "d3";
import { Loader2 } from "lucide-react";

// MeSH terms that add no insight — filter out
const STOP_TERMS = new Set([
  "humans", "male", "female", "aged", "middle aged", "aged, 80 and over",
  "adult", "young adult", "adolescent", "child", "infant", "animals",
  "treatment outcome", "follow-up studies", "time factors", "prognosis",
  "risk factors", "retrospective studies", "prospective studies",
  "cohort studies", "cross-sectional studies", "prevalence", "incidence",
  "survival rate", "survival analysis", "kaplan-meier estimate",
  "proportional hazards models", "multivariate analysis", "logistic models",
  "predictive value of tests", "sensitivity and specificity",
  "reproducibility of results", "reference values", "risk assessment",
  "united states", "europe", "japan", "korea", "china",
  "journal article", "research support", "english abstract",
  "comparative study", "multicenter study", "randomized controlled trial",
  "evaluation study", "validation study", "clinical trial",
  "practice guideline", "meta-analysis", "systematic review", "review",
  "case reports", "editorial", "letter", "comment",
]);

// Study type display
const TYPE_LABELS = {
  rct: "Clinical Trial", basic_research: "Basic Research", biomarker: "Biomarker",
  retrospective: "Retrospective", prospective: "Prospective", meta_analysis: "Meta-analysis",
  ai_ml: "AI / ML", surgical: "Surgical", imaging: "Imaging",
  epidemiology: "Epidemiology", guideline: "Guideline", review: "Review",
};

// Color palette for clusters
const CLUSTER_COLORS = ["#007AFF", "#34C759", "#FF9500", "#AF52DE", "#FF3B30", "#00C7BE", "#5856D6", "#FF2D55"];

function buildGraph(papers) {
  const kwCount = {};
  const cooccur = {};

  for (const p of papers) {
    const terms = new Set();
    // Only meaningful keywords/MeSH
    for (const k of (p.keywords || [])) {
      const kl = k.toLowerCase().trim();
      if (kl.length > 2 && kl.length < 40 && !STOP_TERMS.has(kl)) terms.add(kl);
    }
    for (const m of (p.mesh_terms || [])) {
      const ml = m.toLowerCase().trim();
      if (ml.length > 2 && ml.length < 40 && !STOP_TERMS.has(ml)) terms.add(ml);
    }

    const arr = [...terms];
    for (const t of arr) kwCount[t] = (kwCount[t] || 0) + 1;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = [arr[i], arr[j]].sort().join("|||");
        cooccur[key] = (cooccur[key] || 0) + 1;
      }
    }
  }

  // Top 15 keywords
  const topKw = Object.entries(kwCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([k]) => k);
  const topSet = new Set(topKw);

  const nodes = topKw.map(k => ({ id: k, count: kwCount[k] }));
  const links = [];
  for (const [key, count] of Object.entries(cooccur)) {
    if (count < 2) continue;
    const [a, b] = key.split("|||");
    if (topSet.has(a) && topSet.has(b)) {
      links.push({ source: a, target: b, value: count });
    }
  }

  // Assign cluster colors based on connectivity (simple: first connected component)
  const adj = {};
  for (const n of nodes) adj[n.id] = [];
  for (const l of links) { adj[l.source]?.push(l.target); adj[l.target]?.push(l.source); }

  let clusterIdx = 0;
  const visited = new Set();
  const nodeCluster = {};
  for (const n of nodes) {
    if (visited.has(n.id)) continue;
    const queue = [n.id];
    while (queue.length) {
      const cur = queue.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);
      nodeCluster[cur] = clusterIdx;
      for (const nb of (adj[cur] || [])) if (!visited.has(nb)) queue.push(nb);
    }
    clusterIdx++;
  }
  nodes.forEach(n => { n.cluster = nodeCluster[n.id] || 0; });

  return { nodes, links };
}

function generateInsightText(papers, graph) {
  if (!papers.length) return "";

  // Study type distribution
  const typeCounts = {};
  for (const p of papers) {
    const t = p.study_type || "other";
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];

  // Top keywords
  const topKws = graph.nodes.slice(0, 3).map(n => n.id);

  // Journal distribution
  const journalCounts = {};
  for (const p of papers) {
    if (p.journal) journalCounts[p.journal] = (journalCounts[p.journal] || 0) + 1;
  }
  const topJournal = Object.entries(journalCounts).sort((a, b) => b[1] - a[1])[0];

  const lines = [];
  if (topKws.length >= 2) {
    lines.push(`Your reading is centered on ${topKws.slice(0, 2).join(" and ")}.`);
  }
  if (topType) {
    lines.push(`${Math.round(topType[1] / papers.length * 100)}% of your papers are ${TYPE_LABELS[topType[0]] || topType[0]}.`);
  }
  if (topJournal) {
    lines.push(`Most read journal: ${topJournal[0]} (${topJournal[1]} papers).`);
  }
  return lines.join(" ");
}

function NetworkGraph({ graph, width, height }) {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!graph.nodes.length) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const maxCount = d3.max(graph.nodes, d => d.count) || 1;
    const maxLink = d3.max(graph.links, d => d.value) || 1;

    // Deep copy for D3 mutation
    const nodes = graph.nodes.map(d => ({ ...d }));
    const links = graph.links.map(d => ({ ...d }));

    const simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(d => d.id).distance(100).strength(d => d.value / maxLink * 0.5))
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(d => nodeRadius(d, maxCount) + 15));

    const g = svg.append("g");
    svg.call(d3.zoom().scaleExtent([0.3, 3]).on("zoom", (e) => g.attr("transform", e.transform)));

    // Links
    g.append("g").selectAll("line")
      .data(links).join("line")
      .attr("stroke", "#D1D5DB")
      .attr("stroke-width", d => Math.max(1, d.value / maxLink * 5))
      .attr("stroke-opacity", 0.5)
      .attr("stroke-linecap", "round");

    // Node groups
    const node = g.append("g").selectAll("g")
      .data(nodes).join("g")
      .call(d3.drag()
        .on("start", (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on("end", (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));

    // Background circle (filled, soft)
    node.append("circle")
      .attr("r", d => nodeRadius(d, maxCount))
      .attr("fill", d => CLUSTER_COLORS[d.cluster % CLUSTER_COLORS.length])
      .attr("fill-opacity", 0.12)
      .attr("stroke", d => CLUSTER_COLORS[d.cluster % CLUSTER_COLORS.length])
      .attr("stroke-width", 2)
      .attr("stroke-opacity", 0.6);

    // Label
    node.append("text")
      .text(d => d.id.length > 18 ? d.id.slice(0, 16) + "…" : d.id)
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("font-size", d => Math.max(10, nodeRadius(d, maxCount) * 0.55))
      .attr("fill", d => CLUSTER_COLORS[d.cluster % CLUSTER_COLORS.length])
      .attr("font-weight", "600")
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("pointer-events", "none");

    // Count badge
    node.append("text")
      .text(d => d.count)
      .attr("text-anchor", "middle")
      .attr("dy", d => nodeRadius(d, maxCount) + 12)
      .attr("font-size", 9)
      .attr("fill", "#86868B")
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("pointer-events", "none");

    simulation.on("tick", () => {
      g.selectAll("line")
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      node.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    return () => simulation.stop();
  }, [graph, width, height]);

  return <svg ref={svgRef} width={width} height={height} />;
}

function nodeRadius(d, maxCount) {
  return Math.sqrt(d.count / maxCount) * 30 + 12;
}

export default function Insights() {
  const { user } = useAuth();
  const [papers, setPapers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, liked: 0 });
  const containerRef = useRef(null);
  const [dims, setDims] = useState({ w: 800, h: 500 });

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: fbs } = await supabase.from("feedbacks").select("paper_id").eq("user_id", user.id).eq("action", "like");
      const { data: reads } = await supabase.from("read_history").select("paper_id").eq("user_id", user.id);
      const paperIds = [...new Set([...(fbs || []).map(f => f.paper_id), ...(reads || []).map(r => r.paper_id)])];
      if (paperIds.length) {
        const { data } = await supabase.from("papers").select("id,keywords,mesh_terms,study_type,journal").in("id", paperIds);
        setPapers(data || []);
      }
      setStats({ total: paperIds.length, liked: (fbs || []).length });
      setLoading(false);
    })();
  }, [user]);

  useEffect(() => {
    const resize = () => {
      if (containerRef.current) setDims({ w: containerRef.current.offsetWidth - 48, h: Math.max(400, window.innerHeight - 300) });
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center" style={{ height: "calc(100vh - 56px)" }}>
      <Loader2 size={32} className="text-accent animate-spin" />
    </div>
  );

  const graph = buildGraph(papers);
  const insight = generateInsightText(papers, graph);

  // Study type distribution for mini chart
  const typeCounts = {};
  for (const p of papers) { const t = p.study_type || "other"; typeCounts[t] = (typeCounts[t] || 0) + 1; }
  const typeEntries = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxTypeCount = typeEntries[0]?.[1] || 1;

  return (
    <div className="h-full overflow-y-auto" ref={containerRef}>
      <div className="p-4 sm:p-6 lg:p-8 max-w-[1200px] mx-auto">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-[1.222rem] font-bold text-text1 mb-1">Research Insights</h1>
          <div className="flex items-center gap-4 text-[0.833rem]">
            <span className="text-text3"><span className="font-semibold text-text1">{stats.total}</span> papers read</span>
            <span className="text-text3"><span className="font-semibold text-accent">{stats.liked}</span> liked</span>
          </div>
        </div>

        {graph.nodes.length >= 3 ? (
          <>
            {/* Insight summary */}
            {insight && (
              <div className="bg-[rgba(0,122,255,0.04)] border border-[rgba(0,122,255,0.1)] rounded-xl p-4 mb-6">
                <p className="text-[0.889rem] text-text1 leading-relaxed">{insight}</p>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Network graph — 2/3 width */}
              <div className="lg:col-span-2 bg-card rounded-xl border border-border overflow-hidden" style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
                <div className="px-5 py-3 border-b border-border">
                  <h2 className="text-[0.889rem] font-semibold text-text1">Research Network</h2>
                  <p className="text-[0.722rem] text-text3">{graph.nodes.length} topics · {graph.links.length} connections · drag to explore</p>
                </div>
                <NetworkGraph graph={graph} width={Math.min(dims.w, 800)} height={dims.h} />
              </div>

              {/* Side panel — study type distribution */}
              <div className="space-y-4">
                <div className="bg-card rounded-xl border border-border p-5" style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
                  <h2 className="text-[0.889rem] font-semibold text-text1 mb-4">Study Types</h2>
                  <div className="space-y-3">
                    {typeEntries.map(([type, count], i) => (
                      <div key={type}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[0.778rem] text-text2">{TYPE_LABELS[type] || type}</span>
                          <span className="text-[0.722rem] text-text3 font-mono">{count}</span>
                        </div>
                        <div className="h-2 bg-hover rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all" style={{
                            width: `${(count / maxTypeCount) * 100}%`,
                            background: CLUSTER_COLORS[i % CLUSTER_COLORS.length],
                          }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Top keywords list */}
                <div className="bg-card rounded-xl border border-border p-5" style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
                  <h2 className="text-[0.889rem] font-semibold text-text1 mb-3">Top Keywords</h2>
                  <div className="space-y-2">
                    {graph.nodes.slice(0, 8).map((n, i) => (
                      <div key={n.id} className="flex items-center gap-2">
                        <span className="text-[0.722rem] text-text3 w-4 text-right">{i + 1}</span>
                        <span className="text-[0.833rem] text-text1 flex-1">{n.id}</span>
                        <span className="text-[0.722rem] text-text3 font-mono">{n.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="bg-card rounded-xl border border-border p-8 text-center">
            <p className="text-[1rem] text-text1 font-semibold mb-2">Not enough data yet</p>
            <p className="text-[0.889rem] text-text3">Read and like more papers to see your research insights.</p>
          </div>
        )}
      </div>
    </div>
  );
}
