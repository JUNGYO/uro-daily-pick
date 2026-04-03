import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import * as d3 from "d3";
import { Loader2 } from "lucide-react";

function buildGraph(papers) {
  const kwCount = {};   // keyword -> count
  const cooccur = {};   // "kw1|||kw2" -> count

  for (const p of papers) {
    const terms = new Set();
    for (const k of (p.keywords || [])) terms.add(k.toLowerCase());
    for (const m of (p.mesh_terms || [])) terms.add(m.toLowerCase());
    if (p.study_type && p.study_type !== "other") terms.add(p.study_type.replace(/_/g, " "));

    const arr = [...terms].filter(t => t.length > 2 && t.length < 50);
    for (const t of arr) kwCount[t] = (kwCount[t] || 0) + 1;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = [arr[i], arr[j]].sort().join("|||");
        cooccur[key] = (cooccur[key] || 0) + 1;
      }
    }
  }

  // Top 40 keywords by frequency
  const topKw = Object.entries(kwCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
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

  return { nodes, links };
}

const TYPE_COLORS = {
  "rct": "#007AFF", "basic research": "#AF52DE", "biomarker": "#FF9500",
  "retrospective": "#8E8E93", "prospective": "#34C759", "meta analysis": "#FF3B30",
  "ai ml": "#5856D6", "surgical": "#00C7BE", "imaging": "#007AFF",
  "epidemiology": "#FF9500", "guideline": "#FF3B30", "review": "#8E8E93",
};

function NetworkGraph({ graph, width, height }) {
  const svgRef = useRef(null);

  useEffect(() => {
    if (!graph.nodes.length) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const maxCount = d3.max(graph.nodes, d => d.count) || 1;
    const maxLink = d3.max(graph.links, d => d.value) || 1;

    const simulation = d3.forceSimulation(graph.nodes)
      .force("link", d3.forceLink(graph.links).id(d => d.id).distance(80).strength(d => d.value / maxLink * 0.3))
      .force("charge", d3.forceManyBody().strength(-120))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(d => Math.sqrt(d.count / maxCount) * 25 + 10));

    const g = svg.append("g");

    // Zoom
    svg.call(d3.zoom().scaleExtent([0.3, 3]).on("zoom", (e) => g.attr("transform", e.transform)));

    // Links
    const link = g.append("g").selectAll("line")
      .data(graph.links).join("line")
      .attr("stroke", "#E5E5EA")
      .attr("stroke-width", d => Math.max(1, d.value / maxLink * 4))
      .attr("stroke-opacity", 0.6);

    // Nodes
    const node = g.append("g").selectAll("g")
      .data(graph.nodes).join("g")
      .call(d3.drag()
        .on("start", (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on("end", (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));

    node.append("circle")
      .attr("r", d => Math.sqrt(d.count / maxCount) * 20 + 6)
      .attr("fill", d => TYPE_COLORS[d.id] || "#007AFF")
      .attr("fill-opacity", 0.15)
      .attr("stroke", d => TYPE_COLORS[d.id] || "#007AFF")
      .attr("stroke-width", 1.5);

    node.append("text")
      .text(d => d.id.length > 20 ? d.id.slice(0, 18) + "..." : d.id)
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("font-size", d => Math.max(9, Math.sqrt(d.count / maxCount) * 12 + 8))
      .attr("fill", "#1D1D1F")
      .attr("font-weight", d => d.count >= maxCount * 0.5 ? "600" : "400")
      .attr("font-family", "Inter, system-ui, sans-serif");

    // Tooltip
    node.append("title").text(d => `${d.id} (${d.count} papers)`);

    simulation.on("tick", () => {
      link.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      node.attr("transform", d => `translate(${d.x},${d.y})`);
    });

    return () => simulation.stop();
  }, [graph, width, height]);

  return <svg ref={svgRef} width={width} height={height} style={{ background: "#FAFAFA", borderRadius: 12 }} />;
}

export default function Insights() {
  const { user } = useAuth();
  const [papers, setPapers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, liked: 0, streak: 0 });
  const containerRef = useRef(null);
  const [dims, setDims] = useState({ w: 800, h: 500 });

  useEffect(() => {
    if (!user) return;
    (async () => {
      // Get liked + read papers
      const { data: fbs } = await supabase.from("feedbacks").select("paper_id").eq("user_id", user.id).eq("action", "like");
      const { data: reads } = await supabase.from("read_history").select("paper_id").eq("user_id", user.id);

      const paperIds = [...new Set([...(fbs || []).map(f => f.paper_id), ...(reads || []).map(r => r.paper_id)])];

      if (paperIds.length) {
        const { data: paperData } = await supabase.from("papers").select("id,keywords,mesh_terms,study_type,journal").in("id", paperIds);
        setPapers(paperData || []);
      }

      setStats({ total: paperIds.length, liked: (fbs || []).length, streak: 0 });
      setLoading(false);
    })();
  }, [user]);

  useEffect(() => {
    const resize = () => {
      if (containerRef.current) {
        setDims({ w: containerRef.current.offsetWidth, h: Math.max(400, window.innerHeight - 250) });
      }
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

  return (
    <div className="h-full overflow-y-auto" ref={containerRef}>
      <div className="p-4 sm:p-6 lg:p-8">
        {/* Stats */}
        <div className="flex items-center gap-6 mb-6">
          <h1 className="text-[1.222rem] font-bold text-text1">Research Insights</h1>
          <div className="flex items-center gap-4 text-[0.833rem]">
            <span className="text-text3"><span className="font-semibold text-text1">{stats.total}</span> papers read</span>
            <span className="text-text3"><span className="font-semibold text-accent">{stats.liked}</span> liked</span>
          </div>
        </div>

        {/* Network */}
        {graph.nodes.length > 3 ? (
          <div className="bg-card rounded-xl border border-border overflow-hidden" style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="text-[0.889rem] font-semibold text-text1">Your Research Network</h2>
                <p className="text-[0.722rem] text-text3">Topics connected by co-occurrence in papers you've read. Drag to explore.</p>
              </div>
              <span className="text-[0.722rem] text-text3">{graph.nodes.length} topics · {graph.links.length} connections</span>
            </div>
            <NetworkGraph graph={graph} width={dims.w - 48} height={dims.h} />
          </div>
        ) : (
          <div className="bg-card rounded-xl border border-border p-8 text-center">
            <p className="text-[1rem] text-text1 font-semibold mb-2">Not enough data yet</p>
            <p className="text-[0.889rem] text-text3">Read and like more papers to build your research network visualization.</p>
          </div>
        )}
      </div>
    </div>
  );
}
