import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import { Heart, X, ExternalLink, RefreshCw, Loader2, Tag, User2, BookOpen, FlaskConical, Clock, Star, TrendingUp, Zap, ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from "lucide-react";

/* ── Study type badge colors ── */
const TYPE_STYLE = {
  rct:                { label: "RCT",            color: "#007AFF", bg: "rgba(0,122,255,0.08)" },
  basic_research:     { label: "Basic Research",  color: "#AF52DE", bg: "rgba(175,82,222,0.08)" },
  biomarker:          { label: "Biomarker",       color: "#FF9500", bg: "rgba(255,149,0,0.08)" },
  retrospective:      { label: "Retrospective",   color: "#8E8E93", bg: "rgba(142,142,147,0.08)" },
  prospective:        { label: "Prospective",     color: "#34C759", bg: "rgba(52,199,89,0.08)" },
  meta_analysis:      { label: "Meta-analysis",   color: "#FF3B30", bg: "rgba(255,59,48,0.08)" },
  ai_ml:              { label: "AI / ML",          color: "#5856D6", bg: "rgba(88,86,214,0.08)" },
  surgical:           { label: "Surgical",         color: "#00C7BE", bg: "rgba(0,199,190,0.08)" },
  imaging:            { label: "Imaging",          color: "#007AFF", bg: "rgba(0,122,255,0.08)" },
  epidemiology:       { label: "Epidemiology",     color: "#FF9500", bg: "rgba(255,149,0,0.08)" },
  guideline:          { label: "Guideline",        color: "#FF3B30", bg: "rgba(255,59,48,0.08)" },
  review:             { label: "Review",           color: "#8E8E93", bg: "rgba(142,142,147,0.08)" },
  case_report:        { label: "Case Report",      color: "#8E8E93", bg: "rgba(142,142,147,0.08)" },
  other:              { label: "Article",           color: "#8E8E93", bg: "rgba(142,142,147,0.06)" },
};

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
    re.test(p) ? <mark key={i} className="bg-[rgba(0,122,255,0.08)] text-accent rounded px-0.5 font-semibold">{p}</mark> : p
  );
}

function TypeBadge({ type }) {
  const s = TYPE_STYLE[type] || TYPE_STYLE.other;
  return (
    <span className="text-[0.722rem] font-semibold px-2 py-0.5 rounded-md shrink-0"
      style={{ color: s.color, background: s.bg }}>
      {s.label}
    </span>
  );
}

/* ═══ List Item ═══ */
function ListItem({ rec, index, selected, onClick }) {
  const fb = rec.feedback_action;
  const st = rec.paper?.study_type;

  return (
    <button onClick={onClick}
      className={`w-full text-left transition-all duration-200 rounded-lg mb-0.5
        ${selected ? "bg-card shadow-sm ring-1 ring-accent/20" : fb === "like" ? "bg-[rgba(52,199,89,0.03)]" : "hover:bg-hover"}
        ${fb === "dislike" ? "opacity-35" : ""}`}
      style={{ padding: "10px 12px", borderLeft: selected ? "3px solid #007AFF" : fb === "like" ? "3px solid #34C759" : "3px solid transparent" }}>
      <div className="flex gap-2.5 items-start">
        <span className="text-[0.722rem] font-bold text-text3 w-4 shrink-0 text-right mt-0.5">{index + 1}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <TypeBadge type={st} />
            {fb === "like" && <Heart size={11} className="text-success fill-success" />}
          </div>
          <p className="text-[0.833rem] font-semibold text-text1 leading-snug line-clamp-2">{rec.paper?.title}</p>
          <p className="text-[0.722rem] text-text3 mt-0.5 truncate">{rec.paper?.journal}</p>
        </div>
      </div>
    </button>
  );
}

/* ═══ Detail Panel ═══ */
function Detail({ rec, onFeedback, onPrev, onNext, hasPrev, hasNext, likeAnim }) {
  const paper = rec.paper;
  const reasons = rec.reasons?.reasons || [];
  const matched = rec.reasons?.matched_terms || [];
  const fb = rec.feedback_action;
  const detailRef = useRef(null);
  const st = paper?.study_type;

  useEffect(() => { detailRef.current?.scrollTo(0, 0); }, [paper?.pmid]);

  if (!paper) return (
    <div className="flex-1 flex items-center justify-center">
      <p className="text-text3 text-[1rem]">Select a paper to read</p>
    </div>
  );

  return (
    <div ref={detailRef} className="flex-1 overflow-y-auto p-4 md:p-5 xl:p-6">
      <div className="bg-card rounded-xl border border-border overflow-hidden" style={{ boxShadow: "0 1px 6px rgba(0,0,0,0.04)" }}>
        <div className="p-5 md:p-6 xl:p-8">

          {/* Meta row */}
          <div className="flex items-center gap-2 flex-wrap mb-4">
            <TypeBadge type={st} />
            <span className="text-[0.833rem] font-semibold text-accent">{paper.journal}</span>
            <span className="w-1 h-1 rounded-full bg-border" />
            <span className="text-[0.833rem] text-text3">{paper.pub_date}</span>
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              <div className="w-16 h-[3px] bg-border rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.min(100, (rec.score / 15) * 100)}%` }} />
              </div>
              <span className="text-[0.778rem] text-text3 font-mono">{rec.score?.toFixed(1)}</span>
            </div>
          </div>

          {/* Title */}
          <h1 className="text-[1.167rem] font-bold leading-[1.35] text-text1 mb-2.5 cursor-pointer hover:text-accent transition-colors"
            onClick={() => window.open(`https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`, "_blank")}>
            {hl(paper.title, matched)}
          </h1>

          {/* Authors */}
          <p className="text-[0.833rem] text-text2 mb-4 leading-relaxed">
            {(paper.authors || []).slice(0, 5).join(", ")}
            {paper.authors?.length > 5 && <span className="text-text3"> et al.</span>}
          </p>

          {/* Why chips */}
          {reasons.length > 0 && (
            <div className="mb-4">
              <p className="text-[0.667rem] font-semibold text-text3 uppercase tracking-widest mb-1.5">Why this paper</p>
              <div className="flex flex-wrap gap-1.5">
                {reasons.map((r, i) => {
                  const s = CHIP_MAP[r.type] || CHIP_MAP.keyword;
                  const Icon = s.icon;
                  return (
                    <span key={i} className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[0.667rem] font-medium"
                      style={{ color: s.color, background: s.bg, border: `1px solid ${s.bdr}` }}>
                      <Icon size={12} />{r.label}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Abstract */}
          {paper.abstract && (
            <p className="text-[0.889rem] leading-[1.7] text-text2">{hl(paper.abstract, matched)}</p>
          )}
        </div>

        {/* Action bar */}
        <div className="border-t border-border px-5 md:px-6 xl:px-8 py-3 flex items-center justify-between">
          {/* Left: prev/next + feedback */}
          <div className="flex items-center gap-2">
            <button onClick={onPrev} disabled={!hasPrev} className="w-8 h-8 rounded-lg flex items-center justify-center text-text3 border border-border hover:bg-hover disabled:opacity-20 transition-colors">
              <ChevronUp size={16} />
            </button>
            <button onClick={onNext} disabled={!hasNext} className="w-8 h-8 rounded-lg flex items-center justify-center text-text3 border border-border hover:bg-hover disabled:opacity-20 transition-colors">
              <ChevronDown size={16} />
            </button>
            <div className="w-px h-6 bg-border mx-1" />
            <button onClick={() => onFeedback("dislike")}
              className="w-10 h-10 rounded-lg flex items-center justify-center transition-all duration-200"
              style={{ background: fb === "dislike" ? "rgba(255,59,48,0.08)" : "#FFF", color: fb === "dislike" ? "#FF3B30" : "#C7C7CC",
                border: `1px solid ${fb === "dislike" ? "rgba(255,59,48,0.2)" : "#E5E5EA"}` }}>
              <X size={20} />
            </button>
            <button onClick={() => onFeedback("like")}
              className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all duration-200 ${likeAnim ? "scale-125" : ""}`}
              style={{ background: fb === "like" ? "rgba(52,199,89,0.08)" : "#FFF", color: fb === "like" ? "#34C759" : "#C7C7CC",
                border: `1px solid ${fb === "like" ? "rgba(52,199,89,0.2)" : "#E5E5EA"}`,
                transition: "all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)" }}>
              <Heart size={20} fill={fb === "like" ? "#34C759" : "none"} />
            </button>
          </div>

          {/* Right */}
          <a href={`https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`} target="_blank" rel="noopener"
            className="h-9 px-4 rounded-lg border border-border text-text2 text-[0.778rem] font-medium flex items-center gap-1.5 hover:bg-hover transition-colors no-underline">
            PubMed <ExternalLink size={13} />
          </a>
        </div>
      </div>
    </div>
  );
}

/* ═══ Mobile Detail (full screen) ═══ */
function MobileDetail({ rec, onFeedback, onBack, likeAnim }) {
  const paper = rec?.paper;
  const reasons = rec?.reasons?.reasons || [];
  const matched = rec?.reasons?.matched_terms || [];
  const fb = rec?.feedback_action;
  if (!paper) return null;

  return (
    <div className="fixed inset-0 z-40 bg-bg overflow-y-auto">
      <div className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
        <button onClick={onBack} className="w-9 h-9 rounded-lg flex items-center justify-center text-accent hover:bg-hover">
          <ChevronLeft size={22} />
        </button>
        <TypeBadge type={paper.study_type} />
        <span className="text-[0.778rem] text-text3 truncate flex-1">{paper.journal}</span>
      </div>
      <div className="p-5">
        <h1 className="text-[1.222rem] font-bold leading-[1.35] text-text1 mb-3">{hl(paper.title, matched)}</h1>
        <p className="text-[0.833rem] text-text2 mb-4">{(paper.authors || []).slice(0, 5).join(", ")}{paper.authors?.length > 5 ? " et al." : ""}</p>
        {reasons.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {reasons.map((r, i) => {
              const s = CHIP_MAP[r.type] || CHIP_MAP.keyword; const Icon = s.icon;
              return <span key={i} className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[0.667rem] font-medium" style={{ color: s.color, background: s.bg, border: `1px solid ${s.bdr}` }}><Icon size={12} />{r.label}</span>;
            })}
          </div>
        )}
        {paper.abstract && <p className="text-[0.889rem] leading-[1.7] text-text2 mb-6">{hl(paper.abstract, matched)}</p>}
      </div>
      <div className="sticky bottom-0 bg-card border-t border-border px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => onFeedback("dislike")} className="w-12 h-12 rounded-xl flex items-center justify-center transition-all"
            style={{ background: fb === "dislike" ? "rgba(255,59,48,0.08)" : "#F2F2F7", color: fb === "dislike" ? "#FF3B30" : "#C7C7CC" }}>
            <X size={24} />
          </button>
          <button onClick={() => onFeedback("like")}
            className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${likeAnim ? "scale-125" : ""}`}
            style={{ background: fb === "like" ? "rgba(52,199,89,0.08)" : "#F2F2F7", color: fb === "like" ? "#34C759" : "#C7C7CC",
              transition: "all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)" }}>
            <Heart size={24} fill={fb === "like" ? "#34C759" : "none"} />
          </button>
        </div>
        <a href={`https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`} target="_blank" rel="noopener"
          className="h-10 px-5 rounded-lg bg-accent text-white text-[0.833rem] font-medium flex items-center gap-1.5 no-underline">
          PubMed <ExternalLink size={14} />
        </a>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════ */
/*  Main Page                         */
/* ═══════════════════════════════════ */
export default function DailyPick() {
  const { user } = useAuth();
  const [recs, setRecs] = useState([]);
  const [cur, setCur] = useState(0);
  const [loading, setLoading] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [likeAnim, setLikeAnim] = useState(false);

  const dwellStart = useRef(null);
  const dwellPaperId = useRef(null);

  const flushDwell = useCallback(async () => {
    if (dwellStart.current && dwellPaperId.current && user) {
      const seconds = Math.round((Date.now() - dwellStart.current) / 1000);
      if (seconds >= 3) {
        await supabase.from("read_history").insert({ user_id: user.id, paper_id: dwellPaperId.current, dwell_seconds: seconds });
      }
    }
    dwellStart.current = null; dwellPaperId.current = null;
  }, [user]);

  useEffect(() => {
    const onLeave = () => flushDwell();
    window.addEventListener("beforeunload", onLeave);
    return () => { flushDwell(); window.removeEventListener("beforeunload", onLeave); };
  }, [flushDwell]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      const today = new Date().toISOString().slice(0, 10);
      const { data: recsData } = await supabase.from("recommendations").select("*, paper:papers(*)").eq("user_id", user.id).eq("rec_date", today).order("score", { ascending: false });
      if (recsData?.length) {
        const paperIds = recsData.map(r => r.paper_id);
        const { data: fbs } = await supabase.from("feedbacks").select("paper_id, action").eq("user_id", user.id).in("paper_id", paperIds);
        const fbMap = Object.fromEntries((fbs || []).map(f => [f.paper_id, f.action]));
        setRecs(recsData.map(r => ({ ...r, feedback_action: fbMap[r.paper_id] || null })));
      }
      setLoading(false);
    })();
  }, [user]);

  const selectPaper = (i) => {
    flushDwell(); setCur(i);
    dwellPaperId.current = recs[i]?.paper_id; dwellStart.current = Date.now();
  };

  const doFeedback = async (action) => {
    const rec = recs[cur]; if (!rec || !user) return;

    // Like animation
    if (action === "like") { setLikeAnim(true); setTimeout(() => setLikeAnim(false), 300); }

    await supabase.rpc("upsert_feedback", { p_user_id: user.id, p_paper_id: rec.paper_id, p_action: action });
    setRecs(p => p.map((r, i) => i === cur ? { ...r, feedback_action: action } : r));

    if (action === "like") {
      let { data: cols } = await supabase.from("collections").select("id").eq("user_id", user.id).eq("name", "Liked Papers").limit(1);
      let colId = cols?.[0]?.id;
      if (!colId) { const { data: c } = await supabase.from("collections").insert({ user_id: user.id, name: "Liked Papers", color: "#34C759" }).select("id").single(); colId = c?.id; }
      if (colId) await supabase.from("collection_papers").upsert({ collection_id: colId, paper_id: rec.paper_id }, { onConflict: "collection_id,paper_id" });
    }

    if ((action === "like" || action === "dislike") && cur < recs.length - 1) {
      setTimeout(() => { selectPaper(cur + 1); setMobileOpen(false); }, 300);
    }
  };

  // Keyboard
  const location = useLocation();
  const curRef = useRef(cur); const recsRef = useRef(recs);
  curRef.current = cur; recsRef.current = recs;

  useEffect(() => {
    if (location.pathname !== "/" && location.pathname !== "") return;
    const h = (e) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      if (e.isComposing) return;
      const c = curRef.current; const len = recsRef.current.length;
      switch (e.key.toLowerCase()) {
        case "arrowdown": case "j": if (c < len - 1) { e.preventDefault(); selectPaper(c + 1); } break;
        case "arrowup": case "k": if (c > 0) { e.preventDefault(); selectPaper(c - 1); } break;
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
        <Loader2 size={32} className="text-accent animate-spin mx-auto mb-3" />
        <p className="text-[0.889rem] text-text3">Loading today's picks...</p>
      </div>
    </div>
  );

  if (!recs.length) return (
    <div className="flex items-center justify-center h-full p-8">
      <div className="text-center max-w-sm">
        <div className="w-16 h-16 rounded-2xl bg-hover flex items-center justify-center mx-auto mb-4">
          <RefreshCw size={28} className="text-text3" />
        </div>
        <p className="text-[1.111rem] font-semibold text-text1 mb-2">No picks yet</p>
        <p className="text-[0.889rem] text-text3 leading-relaxed mb-4">Recommendations are generated every morning at 6:00 AM KST. Make sure your research keywords are set in Settings.</p>
        <a href="/uro-daily-pick/settings" className="text-[0.889rem] text-accent font-medium hover:underline">Go to Settings</a>
      </div>
    </div>
  );

  const fbCount = recs.filter(r => r.feedback_action).length;

  return (
    <>
      {/* Mobile detail overlay */}
      {mobileOpen && (
        <div className="md:hidden">
          <MobileDetail rec={recs[cur]} onFeedback={doFeedback} onBack={() => setMobileOpen(false)} likeAnim={likeAnim} />
        </div>
      )}

      <div className="flex h-full">
        {/* ── List panel ── */}
        <div className={`w-full md:w-[320px] lg:w-[340px] xl:w-[360px] shrink-0 md:border-r border-border flex flex-col bg-bg ${mobileOpen ? "hidden md:flex" : ""}`}>
          <div className="px-4 py-2.5 flex items-center justify-between border-b border-border">
            <span className="text-[0.778rem] font-medium text-text2">{new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</span>
            <span className="text-[0.722rem] text-text3 bg-hover px-2 py-0.5 rounded-md font-medium">{fbCount} / {recs.length} rated</span>
          </div>

          {/* Progress */}
          <div className="px-4 py-2">
            <div className="flex gap-0.5">
              {recs.map((r, i) => (
                <div key={i} className="flex-1 h-1 rounded-full transition-all duration-300"
                  style={{ background: i === cur ? "#007AFF" : r.feedback_action === "like" ? "#34C759" : r.feedback_action === "dislike" ? "#E5E5EA" : "#E5E5EA",
                    opacity: i === cur ? 1 : r.feedback_action ? 1 : 0.5 }} />
              ))}
            </div>
          </div>

          {/* Paper list */}
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {recs.map((r, i) => (
              <ListItem key={r.id} rec={r} index={i} selected={i === cur}
                onClick={() => { selectPaper(i); setMobileOpen(true); }} />
            ))}
          </div>

          {/* Keyboard hints — desktop only */}
          <div className="hidden md:flex px-3 py-2 border-t border-border items-center gap-2">
            {[["↑↓", "navigate"], ["L", "like"], ["D", "skip"]].map(([key, label]) => (
              <span key={key} className="inline-flex items-center gap-1 text-[0.667rem] text-text3">
                <kbd className="px-1.5 py-0.5 bg-hover border border-border rounded text-text2 font-medium text-[0.667rem]">{key}</kbd>
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* ── Detail panel (desktop only) ── */}
        <div className="hidden md:flex flex-1">
          <Detail rec={recs[cur]} onFeedback={doFeedback}
            onPrev={() => cur > 0 && selectPaper(cur - 1)}
            onNext={() => cur < recs.length - 1 && selectPaper(cur + 1)}
            hasPrev={cur > 0} hasNext={cur < recs.length - 1}
            likeAnim={likeAnim} />
        </div>
      </div>
    </>
  );
}
