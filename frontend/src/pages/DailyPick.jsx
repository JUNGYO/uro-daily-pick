import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import { Heart, X, ExternalLink, Sparkles, RefreshCw, Loader2, Tag, User2, BookOpen, FlaskConical, Clock, Star, TrendingUp, Zap } from "lucide-react";

const CHIP_MAP = {
  keyword:         { icon: Tag,          color: "#007AFF", bg: "rgba(0,122,255,0.06)",  bdr: "rgba(0,122,255,0.12)" },
  mesh:            { icon: FlaskConical, color: "#34C759", bg: "rgba(52,199,89,0.06)",  bdr: "rgba(52,199,89,0.12)" },
  learned:         { icon: TrendingUp,   color: "#5856D6", bg: "rgba(88,86,214,0.06)",  bdr: "rgba(88,86,214,0.12)" },
  author:          { icon: User2,        color: "#34C759", bg: "rgba(52,199,89,0.06)",  bdr: "rgba(52,199,89,0.12)" },
  journal:         { icon: BookOpen,     color: "#86868B", bg: "#F2F2F7",               bdr: "#E5E5EA" },
  fresh:           { icon: Zap,          color: "#007AFF", bg: "rgba(0,122,255,0.06)",  bdr: "rgba(0,122,255,0.12)" },
  review:          { icon: Star,         color: "#FF9500", bg: "rgba(255,149,0,0.06)",  bdr: "rgba(255,149,0,0.12)" },
  reading_pattern: { icon: Clock,        color: "#86868B", bg: "#F2F2F7",               bdr: "#E5E5EA" },
};

function hl(text, terms) {
  if (!text || !terms?.length) return text;
  const re = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(re).map((p, i) =>
    re.test(p) ? <mark key={i} className="bg-[rgba(0,122,255,0.08)] text-accent rounded px-1 font-semibold">{p}</mark> : p
  );
}

function ListItem({ rec, index, selected, onClick }) {
  const fb = rec.feedback_action;
  const borderColor = selected ? "#007AFF" : fb === "like" ? "#34C759" : "transparent";
  const bgColor = selected ? "#FFFFFF" : fb === "like" ? "rgba(52,199,89,0.04)" : "transparent";

  return (
    <button onClick={onClick} className="w-full text-left transition-all duration-150"
      style={{ padding: "8px 12px", borderRadius: 8, borderLeft: `3px solid ${borderColor}`, background: bgColor,
        opacity: fb === "dislike" ? 0.4 : 1, boxShadow: selected ? "0 1px 3px rgba(0,0,0,0.04)" : "none" }}>
      <div className="flex gap-2">
        <span className="text-[0.722rem] font-bold text-text3 w-4 shrink-0 text-right pt-0.5">{index + 1}</span>
        <div className="flex-1 min-w-0">
          <p className="text-[0.833rem] font-semibold text-text1 leading-snug line-clamp-2">{rec.paper?.title}</p>
          <div className="flex items-center gap-1 text-[0.722rem] text-text3 mt-0.5">
            <span className="font-medium truncate">{rec.paper?.journal}</span>
            <span>·</span>
            <span className="shrink-0">{rec.paper?.pub_date}</span>
            {fb === "like" && <Heart size={12} className="text-success ml-1 fill-success" />}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-center justify-center ml-2">
          <div className="w-[3px] h-8 bg-border rounded-full overflow-hidden rotate-180">
            <div className="w-full rounded-full bg-accent transition-all" style={{ height: `${Math.min(100, (rec.score / 15) * 100)}%` }} />
          </div>
        </div>
      </div>
    </button>
  );
}

function Detail({ rec, onFeedback }) {
  const paper = rec.paper;
  const reasons = rec.reasons?.reasons || [];
  const matched = rec.reasons?.matched_terms || [];
  const fb = rec.feedback_action;
  const detailRef = useRef(null);

  useEffect(() => { detailRef.current?.scrollTo(0, 0); }, [paper?.pmid]);

  if (!paper) return <div className="flex-1 flex items-center justify-center"><p className="text-text3">Select a paper</p></div>;

  return (
    <div ref={detailRef} className="flex-1 overflow-y-auto p-4 xl:p-6">
      <div className="bg-card rounded-xl border border-border overflow-hidden" style={{ boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}>
        <div className="p-5 md:p-6 xl:p-8">
          {/* Meta */}
          <div className="flex items-center gap-2.5 flex-wrap mb-3">
            <span className="text-[0.889rem] font-semibold text-accent">{paper.journal}</span>
            <span className="w-1 h-1 rounded-full bg-border" />
            <span className="text-[0.889rem] text-text3">{paper.pub_date}</span>
            {paper.paper_type !== "article" && (
              <span className="text-[0.778rem] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-[rgba(255,59,48,0.06)] text-danger border border-[rgba(255,59,48,0.12)]">
                {paper.paper_type}
              </span>
            )}
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              <div className="w-20 h-[3px] bg-border rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (rec.score / 15) * 100)}%` }} />
              </div>
              <span className="text-[0.889rem] text-text3 font-mono">{rec.score?.toFixed(1)}</span>
            </div>
          </div>

          {/* Title */}
          <h1 className="text-[1.222rem] font-bold leading-[1.35] text-text1 mb-2 cursor-pointer hover:text-accent transition-colors"
            onClick={() => window.open(`https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`, "_blank")}>
            {hl(paper.title, matched)}
          </h1>

          {/* Authors */}
          <p className="text-[0.889rem] text-text2 mb-3 leading-relaxed">
            {(paper.authors || []).slice(0, 5).join(", ")}
            {paper.authors?.length > 5 && <span className="text-text3"> et al.</span>}
          </p>

          {/* Why chips */}
          {reasons.length > 0 && (
            <div className="mb-3">
              <p className="text-[0.722rem] font-semibold text-text3 uppercase tracking-wider mb-1.5">Why this paper</p>
              <div className="flex flex-wrap gap-2">
                {reasons.map((r, i) => {
                  const s = CHIP_MAP[r.type] || CHIP_MAP.keyword;
                  const Icon = s.icon;
                  return (
                    <span key={i} className="inline-flex items-center gap-1 h-6 px-2 rounded text-[0.667rem] font-medium"
                      style={{ color: s.color, background: s.bg, border: `1px solid ${s.bdr}` }}>
                      <Icon size={14} />{r.label}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Abstract */}
          {paper.abstract && (
            <p className="text-[0.889rem] leading-[1.65] text-text2 mb-4">{hl(paper.abstract, matched)}</p>
          )}
        </div>

        {/* Actions — Skip or Like (like = save to collection) */}
        <div className="border-t border-border px-5 md:px-6 xl:px-8 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => onFeedback("dislike")}
              className="w-10 h-10 rounded-lg flex items-center justify-center transition-all duration-150"
              style={{ background: fb === "dislike" ? "rgba(255,59,48,0.06)" : "#FFF", color: fb === "dislike" ? "#FF3B30" : "#86868B",
                border: `1px solid ${fb === "dislike" ? "rgba(255,59,48,0.15)" : "#E5E5EA"}`, transform: fb === "dislike" ? "scale(1.06)" : "scale(1)" }}>
              <X size={22} />
            </button>
            <button onClick={() => onFeedback("like")}
              className="w-10 h-10 rounded-lg flex items-center justify-center transition-all duration-150"
              style={{ background: fb === "like" ? "rgba(52,199,89,0.06)" : "#FFF", color: fb === "like" ? "#34C759" : "#86868B",
                border: `1px solid ${fb === "like" ? "rgba(52,199,89,0.15)" : "#E5E5EA"}`, transform: fb === "like" ? "scale(1.06)" : "scale(1)" }}>
              <Heart size={22} fill={fb === "like" ? "#34C759" : "none"} />
            </button>
          </div>
          <a href={`https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`} target="_blank" rel="noopener"
            className="h-10 px-5 rounded-lg border border-border text-text2 text-[0.889rem] font-medium flex items-center gap-2 hover:bg-hover transition-colors no-underline">
            PubMed <ExternalLink size={14} />
          </a>
        </div>
      </div>
    </div>
  );
}

export default function DailyPick() {
  const { user } = useAuth();
  const [recs, setRecs] = useState([]);
  const [cur, setCur] = useState(0);
  const [loading, setLoading] = useState(true);

  // Dwell tracking
  const dwellStart = useRef(null);
  const dwellPaperId = useRef(null);

  const flushDwell = useCallback(async () => {
    if (dwellStart.current && dwellPaperId.current && user) {
      const seconds = Math.round((Date.now() - dwellStart.current) / 1000);
      if (seconds >= 3) {
        await supabase.from("read_history").insert({
          user_id: user.id, paper_id: dwellPaperId.current, dwell_seconds: seconds,
        });
      }
    }
    dwellStart.current = null;
    dwellPaperId.current = null;
  }, [user]);

  useEffect(() => {
    const onLeave = () => flushDwell();
    window.addEventListener("beforeunload", onLeave);
    return () => { flushDwell(); window.removeEventListener("beforeunload", onLeave); };
  }, [flushDwell]);

  // Load recommendations
  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setLoading(true);
      const today = new Date().toISOString().slice(0, 10);
      const { data: recsData } = await supabase
        .from("recommendations")
        .select("*, paper:papers(*)")
        .eq("user_id", user.id)
        .eq("rec_date", today)
        .order("score", { ascending: false });

      if (recsData?.length) {
        // Load feedbacks for these papers
        const paperIds = recsData.map(r => r.paper_id);
        const { data: fbs } = await supabase
          .from("feedbacks")
          .select("paper_id, action")
          .eq("user_id", user.id)
          .in("paper_id", paperIds);
        const fbMap = Object.fromEntries((fbs || []).map(f => [f.paper_id, f.action]));
        setRecs(recsData.map(r => ({ ...r, feedback_action: fbMap[r.paper_id] || null })));
      }
      setLoading(false);
    };
    load();
  }, [user]);

  const selectPaper = (i) => {
    flushDwell();
    setCur(i);
    dwellPaperId.current = recs[i]?.paper_id;
    dwellStart.current = Date.now();
  };

  const doFeedback = async (action) => {
    const rec = recs[cur];
    if (!rec || !user) return;
    await supabase.rpc("upsert_feedback", { p_user_id: user.id, p_paper_id: rec.paper_id, p_action: action });
    setRecs(p => p.map((r, i) => i === cur ? { ...r, feedback_action: action } : r));

    // Like → auto-add to "Liked Papers" collection
    if (action === "like") {
      // Get or create the default collection
      let { data: cols } = await supabase.from("collections").select("id").eq("user_id", user.id).eq("name", "Liked Papers").limit(1);
      let colId;
      if (cols?.length) {
        colId = cols[0].id;
      } else {
        const { data: newCol } = await supabase.from("collections").insert({ user_id: user.id, name: "Liked Papers", color: "#34C759" }).select("id").single();
        colId = newCol?.id;
      }
      if (colId) {
        await supabase.from("collection_papers").upsert({ collection_id: colId, paper_id: rec.paper_id }, { onConflict: "collection_id,paper_id" });
      }
    }

    if ((action === "like" || action === "dislike") && cur < recs.length - 1) {
      setTimeout(() => selectPaper(cur + 1), 200);
    }
  };

  // Keyboard — only on DailyPick page, only when no input focused
  const location = useLocation();
  const curRef = useRef(cur);
  const recsRef = useRef(recs);
  curRef.current = cur;
  recsRef.current = recs;

  useEffect(() => {
    // Only register when on the root page
    const isPickPage = location.pathname === "/" || location.pathname === "";

    if (!isPickPage) return;

    const h = (e) => {
      const el = document.activeElement;
      if (!el) return;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return;
      if (e.isComposing) return;

      const c = curRef.current;
      const len = recsRef.current.length;

      switch (e.key.toLowerCase()) {
        case "arrowdown": case "j": if (c < len - 1) { e.preventDefault(); selectPaper(c + 1); } break;
        case "arrowup":   case "k": if (c > 0) { e.preventDefault(); selectPaper(c - 1); } break;
        case "l": doFeedback("like"); break;
        case "d": doFeedback("dislike"); break;
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [location.pathname]);

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <Loader2 size={36} className="text-accent animate-spin mx-auto mb-4" />
        <p className="text-text3">Loading today's picks...</p>
      </div>
    </div>
  );

  if (!recs.length) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <Sparkles size={48} className="text-border mx-auto mb-5" />
        <p className="text-[1.333rem] font-semibold text-text1 mb-2">No picks yet</p>
        <p className="text-text3">Recommendations are generated daily at 06:00 UTC.<br/>Add your research keywords in Settings.</p>
      </div>
    </div>
  );

  const fbCount = recs.filter(r => r.feedback_action).length;

  return (
    <div className="flex h-full">
      {/* List */}
      <div className="w-full md:w-[300px] lg:w-[340px] xl:w-[360px] shrink-0 border-r border-border flex flex-col bg-bg">
        <div className="px-4 py-2 flex items-center justify-between">
          <span className="text-[0.778rem] text-text3">{new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
          <span className="text-[0.778rem] text-text3 font-mono">{fbCount}/{recs.length}</span>
        </div>
        <div className="px-4 mb-1">
          <div className="flex gap-0.5">
            {recs.map((r, i) => (
              <div key={i} className="flex-1 h-[2px] rounded-full transition-colors duration-300"
                style={{ background: i === cur ? "#007AFF" : r.feedback_action === "like" ? "#34C759" : "#E5E5EA" }} />
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-1.5 pb-1">
          {recs.map((r, i) => (
            <ListItem key={r.id} rec={r} index={i} selected={i === cur} onClick={() => selectPaper(i)} />
          ))}
        </div>
        <div className="px-3 py-2 border-t border-border flex items-center gap-1.5 flex-wrap">
          {[["↑↓", ""], ["L", "like"], ["D", "skip"]].map(([key, label]) => (
            <span key={key} className="inline-flex items-center gap-0.5 text-[0.667rem] text-text3">
              <kbd className="px-1 py-0.5 bg-hover border border-border rounded text-[0.667rem] text-text2 font-medium">{key}</kbd>
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Detail */}
      {recs[cur] && <Detail rec={recs[cur]} onFeedback={doFeedback} />}
    </div>
  );
}
