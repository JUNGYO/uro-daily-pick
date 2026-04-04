import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import { Heart, X, ExternalLink, RefreshCw, Tag, User2, BookOpen, FlaskConical, Clock, Star, TrendingUp, Zap, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Share2, Copy, Check } from "lucide-react";

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

/* ═══ Skeleton Loading ═══ */
function SkeletonList() {
  return (
    <div className="flex" style={{ height: "calc(100dvh - 48px - env(safe-area-inset-bottom, 0px))" }}>
      <div className="w-full md:w-[320px] lg:w-[340px] xl:w-[360px] shrink-0 md:border-r border-border flex flex-col bg-bg">
        <div className="px-4 py-2.5 border-b border-border">
          <div className="h-5 w-24 bg-border/50 rounded animate-pulse mx-auto" />
        </div>
        <div className="px-4 py-2"><div className="flex gap-0.5">{[...Array(5)].map((_, i) => <div key={i} className="flex-1 h-1 rounded-full bg-border/50 animate-pulse" />)}</div></div>
        <div className="flex-1 px-2 pb-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="rounded-lg mb-0.5 p-3" style={{ borderLeft: "3px solid transparent", animationDelay: `${i * 100}ms` }}>
              <div className="flex gap-2.5">
                <div className="w-4 h-4 rounded bg-border/50 animate-pulse shrink-0" />
                <div className="flex-1">
                  <div className="h-4 w-16 bg-border/50 rounded animate-pulse mb-2" />
                  <div className="h-4 w-full bg-border/50 rounded animate-pulse mb-1.5" />
                  <div className="h-4 w-3/4 bg-border/50 rounded animate-pulse mb-1.5" />
                  <div className="h-3 w-40 bg-border/40 rounded animate-pulse" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="hidden md:flex flex-1 items-center justify-center">
        <div className="w-full max-w-2xl p-8">
          <div className="bg-card rounded-xl border border-border p-8">
            <div className="h-4 w-32 bg-border/50 rounded animate-pulse mb-4" />
            <div className="h-6 w-full bg-border/50 rounded animate-pulse mb-2" />
            <div className="h-6 w-4/5 bg-border/50 rounded animate-pulse mb-4" />
            <div className="h-4 w-60 bg-border/40 rounded animate-pulse mb-6" />
            <div className="bg-[rgba(0,122,255,0.03)] rounded-lg p-4 mb-4">
              <div className="h-3 w-16 bg-border/40 rounded animate-pulse mb-2" />
              <div className="h-4 w-full bg-border/40 rounded animate-pulse mb-1" />
              <div className="h-4 w-5/6 bg-border/40 rounded animate-pulse" />
            </div>
            <div className="space-y-2">{[...Array(4)].map((_, i) => <div key={i} className="h-4 bg-border/30 rounded animate-pulse" style={{ width: `${90 - i * 10}%` }} />)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══ Toast ═══ */
function Toast({ message, onUndo, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 3000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-[slideUp_0.2s_ease-out]">
      <div className="flex items-center gap-3 bg-text1 text-white rounded-xl px-5 py-3 shadow-lg text-[0.833rem] font-medium">
        <span>{message}</span>
        {onUndo && (
          <button onClick={onUndo} className="text-accent font-semibold hover:underline">Undo</button>
        )}
      </div>
    </div>
  );
}

/* ═══ List Item ═══ */
function ListItem({ rec, index, selected, onClick }) {
  const fb = rec.feedback_action;
  const st = rec.paper?.study_type;

  return (
    <button onClick={onClick}
      className={`w-full h-full text-left transition-all duration-200 rounded-lg flex flex-col justify-center
        ${selected ? "bg-card shadow-sm ring-1 ring-accent/20" : fb === "like" ? "bg-[rgba(52,199,89,0.03)]" : "hover:bg-hover"}
        ${fb === "dislike" ? "opacity-35" : ""}`}
      style={{ padding: "6px 10px", borderLeft: selected ? "3px solid #007AFF" : fb === "like" ? "3px solid #34C759" : "3px solid transparent" }}>
      <div className="flex items-start gap-2">
        <span className="text-[0.667rem] font-bold text-text3 w-3 shrink-0 text-right mt-0.5">{index + 1}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <TypeBadge type={st} />
            <span className="text-[0.667rem] text-text3 truncate">{rec.paper?.journal}</span>
            {rec.paper?.clinical_relevance >= 4 && <span className="text-[0.611rem] font-bold text-danger shrink-0">★</span>}
            {fb === "like" && <Heart size={10} className="text-success fill-success shrink-0" />}
          </div>
          <p className="text-[0.722rem] font-medium text-text1 leading-snug">{rec.paper?.title}</p>
        </div>
      </div>
    </button>
  );
}

/* ═══ Collapsible Detail Section ═══ */
function DetailAccordion({ paper }) {
  const [open, setOpen] = useState(false);
  const sd = paper.structured_data ? (typeof paper.structured_data === "string" ? JSON.parse(paper.structured_data) : paper.structured_data) : null;
  const qa = paper.qa_data ? (typeof paper.qa_data === "string" ? JSON.parse(paper.qa_data) : paper.qa_data) : [];
  const hasSd = sd && (sd.study_design || sd.sample_size || sd.key_finding);
  const hasQa = qa?.length > 0;
  if (!hasSd && !hasQa) return null;

  return (
    <div className="mb-4">
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-[0.778rem] font-semibold text-accent hover:underline transition-colors">
        <ChevronRight size={14} className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
        Details & Q&A
      </button>
      {open && (
        <div className="mt-3 space-y-3 animate-[fadeIn_0.15s_ease-out]">
          {hasSd && (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[0.778rem]">
              {sd.study_design && <span className="text-text3">Design: <span className="text-text1 font-medium">{sd.study_design}</span></span>}
              {sd.sample_size && sd.sample_size !== "N/A" && <span className="text-text3">N: <span className="text-text1 font-medium">{sd.sample_size}</span></span>}
              {sd.population && <span className="text-text3">Pop: <span className="text-text1 font-medium">{sd.population}</span></span>}
              {sd.key_finding && <div className="w-full text-text3">Key: <span className="text-text1 font-medium">{sd.key_finding}</span></div>}
            </div>
          )}
          {hasQa && qa.map((item, i) => (
            <div key={i} className="bg-[rgba(255,149,0,0.04)] border border-[rgba(255,149,0,0.1)] rounded-lg p-3">
              <p className="text-[0.833rem] font-semibold text-text1 mb-1">Q. {item.q}</p>
              <p className="text-[0.833rem] leading-[1.6] text-text2">{item.a}</p>
            </div>
          ))}
        </div>
      )}
    </div>
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
  const [copied, setCopied] = useState(null); // 'share' | 'cite'

  const [fadeIn, setFadeIn] = useState(true);
  useEffect(() => {
    detailRef.current?.scrollTo(0, 0);
    setCopied(null);
    setFadeIn(false);
    requestAnimationFrame(() => setFadeIn(true));
  }, [paper?.pmid]);

  if (!paper) return (
    <div className="flex-1 flex items-center justify-center">
      <p className="text-text3 text-[1rem]">Select a paper to read</p>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col">
      <div ref={detailRef} className="flex-1 overflow-y-auto p-4 md:p-5 xl:p-6">
        <div className={`bg-card rounded-xl border border-border overflow-hidden transition-opacity duration-200 ${fadeIn ? "opacity-100" : "opacity-0"}`}
          style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)" }}>
          <div className="p-5 md:p-6 xl:p-8">

          {/* Meta row */}
          <div className="flex items-center gap-2 flex-wrap mb-4">
            <TypeBadge type={st} />
            {paper.clinical_relevance >= 4 && (
              <span className="text-[0.667rem] font-bold px-1.5 py-0.5 rounded-md bg-[rgba(255,59,48,0.08)] text-danger">
                {paper.clinical_relevance === 5 ? "Practice-Changing" : "High Relevance"}
              </span>
            )}
            <span className="text-[0.833rem] font-semibold text-accent">{paper.journal}</span>
            <span className="w-1 h-1 rounded-full bg-border" />
            <span className="text-[0.833rem] text-text3">{paper.pub_date}</span>
            {paper.abstract && (
              <>
                <span className="w-1 h-1 rounded-full bg-border" />
                <span className="text-[0.778rem] text-text3">{Math.max(1, Math.ceil(paper.abstract.split(/\s+/).length / 200))} min read</span>
              </>
            )}
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

          {/* Korean summary */}
          {paper.summary_ko && (
            <div className="bg-[rgba(0,122,255,0.03)] border border-[rgba(0,122,255,0.08)] rounded-lg p-4 mb-4">
              <p className="text-[0.667rem] font-semibold text-accent uppercase tracking-widest mb-1.5">한글 요약</p>
              <p className="text-[0.833rem] leading-[1.7] text-text1">{paper.summary_ko}</p>
            </div>
          )}

          {/* Details accordion (structured data + Q&A) */}
          {(paper.structured_data || paper.qa_data) && <DetailAccordion paper={paper} />}

          {/* Abstract */}
          {paper.abstract && (
            <p className="text-[0.889rem] leading-[1.7] text-text2">{hl(paper.abstract, matched)}</p>
          )}
        </div>
        </div>
      </div>

      {/* Action bar — fixed at bottom of detail panel */}
      <div className="shrink-0 border-t border-border bg-card px-5 md:px-6 xl:px-8 py-2.5 flex items-center justify-between">
          {/* Left: prev/next + feedback + keyboard hints */}
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
            <div className="hidden md:flex items-center gap-1 ml-2 text-[0.611rem] text-text3">
              <kbd className="px-1 py-0.5 bg-hover border border-border rounded font-medium">↑↓</kbd>
              <kbd className="px-1 py-0.5 bg-hover border border-border rounded font-medium">L</kbd>
              <kbd className="px-1 py-0.5 bg-hover border border-border rounded font-medium">D</kbd>
            </div>
          </div>

          {/* Right */}
          <div className="flex items-center gap-1.5">
            {/* Share */}
            <button onClick={() => {
              const url = `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`;
              if (navigator.share) navigator.share({ title: paper.title, url });
              else { navigator.clipboard.writeText(`${paper.title}\n${url}`); setCopied("share"); setTimeout(() => setCopied(null), 1500); }
            }}
              className={`w-9 h-9 rounded-lg border flex items-center justify-center transition-all duration-200
                ${copied === "share" ? "border-success bg-[rgba(52,199,89,0.08)] text-success" : "border-border text-text3 hover:bg-hover"}`} title="Share">
              {copied === "share" ? <Check size={15} /> : <Share2 size={15} />}
            </button>
            {/* Copy citation */}
            <button onClick={() => {
              const authors = (paper.authors || []).slice(0, 3).join(", ") + (paper.authors?.length > 3 ? " et al." : "");
              const cite = `${authors}. ${paper.title} ${paper.journal}. ${paper.pub_date}. PMID: ${paper.pmid}`;
              navigator.clipboard.writeText(cite);
              setCopied("cite"); setTimeout(() => setCopied(null), 1500);
            }}
              className={`w-9 h-9 rounded-lg border flex items-center justify-center transition-all duration-200
                ${copied === "cite" ? "border-success bg-[rgba(52,199,89,0.08)] text-success" : "border-border text-text3 hover:bg-hover"}`} title="Copy citation">
              {copied === "cite" ? <Check size={15} /> : <Copy size={15} />}
            </button>
            {paper.doi && (
              <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noopener"
                className="h-9 px-4 rounded-lg bg-accent text-white text-[0.778rem] font-medium flex items-center gap-1.5 hover:bg-[#0066D6] transition-colors no-underline">
                Full Text <ExternalLink size={13} />
              </a>
            )}
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
      <div className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-border px-4 py-2.5 flex items-center gap-3">
        <button onClick={onBack} className="w-9 h-9 rounded-lg flex items-center justify-center text-accent hover:bg-hover">
          <ChevronLeft size={22} />
        </button>
        <TypeBadge type={paper.study_type} />
        {paper.clinical_relevance >= 4 && (
          <span className="text-[0.611rem] font-bold px-1.5 py-0.5 rounded-md bg-[rgba(255,59,48,0.08)] text-danger">
            {paper.clinical_relevance === 5 ? "Practice-Changing" : "High Relevance"}
          </span>
        )}
        <span className="text-[0.778rem] text-text3 truncate flex-1">{paper.journal}</span>
      </div>
      <div className="p-5 pb-24">
        {/* Meta */}
        <div className="flex items-center gap-2 text-[0.778rem] text-text3 mb-3">
          <span>{paper.pub_date}</span>
          {paper.abstract && (
            <>
              <span className="w-1 h-1 rounded-full bg-border" />
              <span>{Math.max(1, Math.ceil(paper.abstract.split(/\s+/).length / 200))} min read</span>
            </>
          )}
        </div>
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
        {/* Korean summary */}
        {paper.summary_ko && (
          <div className="bg-[rgba(0,122,255,0.03)] border border-[rgba(0,122,255,0.08)] rounded-lg p-4 mb-4">
            <p className="text-[0.667rem] font-semibold text-accent uppercase tracking-widest mb-1.5">한글 요약</p>
            <p className="text-[0.889rem] leading-[1.7] text-text1">{paper.summary_ko}</p>
          </div>
        )}
        {/* Details & Q&A accordion */}
        {(paper.structured_data || paper.qa_data) && <DetailAccordion paper={paper} />}
        {paper.abstract && <p className="text-[0.889rem] leading-[1.7] text-text2 mb-6">{hl(paper.abstract, matched)}</p>}
      </div>
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-card/95 backdrop-blur border-t border-border px-5 py-3 flex items-center justify-between" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
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
const _recsCache = {};
let _cachedUserId = null;

export default function DailyPick() {
  const { user } = useAuth();

  // Clear cache on user change (logout/login)
  if (user?.id !== _cachedUserId) {
    Object.keys(_recsCache).forEach(k => delete _recsCache[k]);
    _cachedUserId = user?.id;
  }
  const [recs, setRecs] = useState([]);
  const [cur, setCur] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retryKey, setRetryKey] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const todayKST = new Date(Date.now() + 9*3600000).toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(todayKST);

  // Mobile back button: push/pop history state instead of navigating away
  const openMobile = () => {
    window.history.pushState({ mobileDetail: true }, "");
    setMobileOpen(true);
  };
  const closeMobile = () => {
    setMobileOpen(false);
  };
  useEffect(() => {
    const onPop = (e) => {
      if (mobileOpen) {
        e.preventDefault();
        setMobileOpen(false);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [mobileOpen]);
  const [likeAnim, setLikeAnim] = useState(false);

  // Dwell tracking — only counts when user is actively interacting
  // Pauses on: tab hidden, 30s no mouse/scroll/key activity
  // Caps at 5 min, min 10s to record
  const dwellPaperId = useRef(null);
  const dwellAccum = useRef(0);
  const dwellLastTick = useRef(null);
  const idleTimer = useRef(null);

  const pauseDwell = useCallback(() => {
    if (dwellLastTick.current) {
      dwellAccum.current += Math.round((Date.now() - dwellLastTick.current) / 1000);
      dwellLastTick.current = null;
    }
  }, []);

  const resumeDwell = useCallback(() => {
    if (dwellPaperId.current && !dwellLastTick.current && !document.hidden) {
      dwellLastTick.current = Date.now();
    }
  }, []);

  const resetIdleTimer = useCallback(() => {
    resumeDwell();
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => pauseDwell(), 30000); // 30s idle → pause
  }, [pauseDwell, resumeDwell]);

  const flushDwell = useCallback(async () => {
    clearTimeout(idleTimer.current);
    pauseDwell();
    const seconds = Math.min(dwellAccum.current, 300);
    if (dwellPaperId.current && user && seconds >= 10) {
      await supabase.from("read_history").insert({
        user_id: user.id, paper_id: dwellPaperId.current, dwell_seconds: seconds,
      });
    }
    dwellPaperId.current = null;
    dwellAccum.current = 0;
    dwellLastTick.current = null;
  }, [user, pauseDwell]);

  useEffect(() => {
    const onVis = () => document.hidden ? pauseDwell() : resetIdleTimer();
    const onActivity = () => resetIdleTimer();
    const onLeave = () => flushDwell();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("mousemove", onActivity, { passive: true });
    window.addEventListener("scroll", onActivity, { passive: true, capture: true });
    window.addEventListener("keydown", onActivity, { passive: true });
    window.addEventListener("beforeunload", onLeave);
    return () => {
      flushDwell();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("scroll", onActivity, { capture: true });
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [flushDwell, pauseDwell, resetIdleTimer]);

  useEffect(() => {
    if (!user) return;

    // Use cached data instantly (no spinner on tab switch)
    const cached = _recsCache[selectedDate];
    if (cached && retryKey === 0) {
      setRecs(cached);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    (async () => {
      try {
        // Try loading pre-generated recommendations for selected date
        const { data: recsData } = await supabase.from("recommendations").select("*, paper:papers(*)").eq("user_id", user.id).eq("rec_date", selectedDate).order("score", { ascending: false });

        if (recsData?.length) {
          const paperIds = recsData.map(r => r.paper_id);
          const { data: fbs } = await supabase.from("feedbacks").select("paper_id, action").eq("user_id", user.id).in("paper_id", paperIds);
          const fbMap = Object.fromEntries((fbs || []).map(f => [f.paper_id, f.action]));
          const result = recsData.map(r => ({ ...r, feedback_action: fbMap[r.paper_id] || null }));
          _recsCache[selectedDate] = result;
          setRecs(result);
        } else {
          // No pre-generated recs — generate on the fly
          await generateInstantRecs(user.id);
        }
      } catch (err) {
        console.error("Failed to load recommendations:", err);
        setError("Failed to load recommendations. Please try again.");
      }
      setLoading(false);
    })();
  }, [user, selectedDate, retryKey]);

  const generateInstantRecs = async (userId) => {
    // Get user profile
    const { data: prof } = await supabase.from("profiles").select("keywords,preferred_journals,preferred_study_types").eq("id", userId).single();
    const keywords = (prof?.keywords || []).map(k => k.toLowerCase());
    const prefJournals = (prof?.preferred_journals || []).map(j => j.toLowerCase());
    const prefTypes = prof?.preferred_study_types || [];

    // Get papers from last 30 days
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const { data: papers } = await supabase.from("papers").select("*").gte("fetched_at", cutoff).order("pub_date", { ascending: false }).limit(300);
    if (!papers?.length) return;

    // Get already-seen papers
    const { data: fbs } = await supabase.from("feedbacks").select("paper_id").eq("user_id", userId);
    const { data: reads } = await supabase.from("read_history").select("paper_id").eq("user_id", userId);
    const seenIds = new Set([...(fbs || []).map(f => f.paper_id), ...(reads || []).map(r => r.paper_id)]);

    // Simple scoring
    const scored = [];
    for (const p of papers) {
      if (seenIds.has(p.id)) continue;
      const title = (p.title || "").toLowerCase();
      const abstract = (p.abstract || "").toLowerCase();
      const journal = (p.journal || "").toLowerCase();
      const pType = p.study_type || "other";

      let score = 0;

      // Keyword match (word boundary)
      for (const kw of keywords) {
        const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        if (re.test(title)) { score += 3; }
        else if (re.test(abstract)) { score += 1; }
      }

      // Journal match
      for (const pj of prefJournals) {
        if (journal.includes(pj) || pj.includes(journal)) { score += 2; break; }
      }

      // Study type match
      if (prefTypes.includes(pType)) { score += 1.5; }

      // Recency bonus
      if (p.pub_date) {
        const days = Math.max(0, (Date.now() - new Date(p.pub_date).getTime()) / 86400000);
        score += Math.max(0, 1 - days / 30);
      }

      // Skip letters and papers without abstract
      if (!abstract || abstract.length < 100) continue;
      if (["reply to", "letter to", "research letter", "letter:", "re:", "erratum", "editorial", "comment on", "correspondence"].some(s => title.includes(s))) continue;

      if (score > 0) scored.push({ paper: p, score: Math.round(score * 100) / 100 });
    }

    scored.sort((a, b) => b.score - a.score);
    const top5 = scored.slice(0, 5);

    if (!top5.length) return;

    // Set recs directly in state (no DB insert — RLS blocks client INSERT on recommendations)
    setRecs(top5.map(({ paper, score }, i) => ({
      id: `instant-${i}`,
      user_id: userId,
      paper_id: paper.id,
      paper,
      score,
      rec_date: selectedDate,
      feedback_action: null,
    })));
  };

  const selectPaper = (i) => {
    flushDwell(); setCur(i);
    dwellPaperId.current = recs[i]?.paper_id;
    dwellAccum.current = 0;
    dwellLastTick.current = Date.now();
  };

  const doFeedback = async (action) => {
    const rec = recs[cur]; if (!rec || !user) return;
    const prevAction = rec.feedback_action;

    // Like animation
    if (action === "like") { setLikeAnim(true); setTimeout(() => setLikeAnim(false), 300); }

    // Optimistic update
    setRecs(p => {
      const updated = p.map((r, i) => i === cur ? { ...r, feedback_action: action } : r);
      _recsCache[selectedDate] = updated;
      return updated;
    });

    // Toast with undo
    const title = rec.paper?.title?.slice(0, 40) + (rec.paper?.title?.length > 40 ? "..." : "");
    setToast({
      message: action === "like" ? `Liked: ${title}` : `Skipped: ${title}`,
      onUndo: () => {
        setRecs(p => {
          const reverted = p.map((r, i) => i === cur ? { ...r, feedback_action: prevAction } : r);
          _recsCache[selectedDate] = reverted;
          return reverted;
        });
        supabase.rpc("upsert_feedback", { p_user_id: user.id, p_paper_id: rec.paper_id, p_action: prevAction || "none" });
        setToast(null);
      },
    });

    await supabase.rpc("upsert_feedback", { p_user_id: user.id, p_paper_id: rec.paper_id, p_action: action });

    if (action === "like") {
      let { data: cols } = await supabase.from("collections").select("id").eq("user_id", user.id).eq("name", "Liked Papers").limit(1);
      let colId = cols?.[0]?.id;
      if (!colId) { const { data: c } = await supabase.from("collections").insert({ user_id: user.id, name: "Liked Papers", color: "#34C759" }).select("id").single(); colId = c?.id; }
      if (colId) await supabase.from("collection_papers").upsert({ collection_id: colId, paper_id: rec.paper_id }, { onConflict: "collection_id,paper_id" });
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

  if (loading) return <SkeletonList />;

  if (error) return (
    <div className="flex items-center justify-center" style={{ height: "calc(100dvh - 48px - env(safe-area-inset-bottom, 0px))" }}>
      <div className="text-center max-w-sm">
        <div className="w-16 h-16 rounded-2xl bg-[rgba(255,59,48,0.06)] flex items-center justify-center mx-auto mb-4">
          <RefreshCw size={28} className="text-danger" />
        </div>
        <p className="text-[1.111rem] font-semibold text-text1 mb-2">Something went wrong</p>
        <p className="text-[0.889rem] text-text3 leading-relaxed mb-4">{error}</p>
        <button onClick={() => { setError(null); setRetryKey(k => k + 1); }}
          className="h-10 px-5 bg-accent text-white rounded-lg text-[0.889rem] font-medium hover:bg-[#0066D6] transition-colors">
          Try again
        </button>
      </div>
    </div>
  );

  if (!recs.length) return (
    <div className="flex items-center justify-center" style={{ height: "calc(100dvh - 48px - env(safe-area-inset-bottom, 0px))" }}>
      <div className="text-center max-w-sm">
        <div className="w-16 h-16 rounded-2xl bg-hover flex items-center justify-center mx-auto mb-4">
          <RefreshCw size={28} className="text-text3" />
        </div>
        <p className="text-[1.111rem] font-semibold text-text1 mb-2">
          {selectedDate !== todayKST ? "No picks for this date" : "No picks yet"}
        </p>
        <p className="text-[0.889rem] text-text3 leading-relaxed mb-4">
          {selectedDate !== todayKST
            ? "There are no recommendations for this date."
            : "New papers are collected every morning at 6:00 AM KST. Make sure your research keywords are set in Settings."}
        </p>
        {selectedDate !== todayKST ? (
          <button onClick={() => { setSelectedDate(todayKST); setCur(0); }}
            className="h-10 px-5 bg-accent text-white rounded-lg text-[0.889rem] font-medium hover:bg-[#0066D6] transition-colors">
            Go to today
          </button>
        ) : (
          <a href="/uro-daily-pick/settings" className="text-[0.889rem] text-accent font-medium hover:underline">Go to Settings</a>
        )}
      </div>
    </div>
  );

  const fbCount = recs.filter(r => r.feedback_action).length;

  return (
    <>
      {/* Mobile detail overlay */}
      {mobileOpen && (
        <div className="md:hidden">
          <MobileDetail rec={recs[cur]} onFeedback={doFeedback} onBack={() => { window.history.back(); }} likeAnim={likeAnim} />
        </div>
      )}

      <div className="flex" style={{ height: "calc(100dvh - 48px - env(safe-area-inset-bottom, 0px))" }}>
        {/* ── List panel ── */}
        <div className={`w-full md:w-[320px] lg:w-[340px] xl:w-[360px] shrink-0 md:border-r border-border flex flex-col bg-bg ${mobileOpen ? "hidden md:flex" : ""}`}>
          <div className="px-4 py-2.5 flex items-center justify-between border-b border-border">
            <div className="flex items-center gap-1">
              <button onClick={() => {
                const d = new Date(selectedDate); d.setDate(d.getDate() - 1);
                setSelectedDate(d.toISOString().slice(0, 10)); setCur(0);
              }} className="w-7 h-7 rounded flex items-center justify-center text-text3 hover:bg-hover">
                <ChevronLeft size={14} />
              </button>
              <span className="text-[0.778rem] font-medium text-text2 min-w-[100px] text-center">
                {selectedDate === todayKST ? "Today" : new Date(selectedDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
              <button onClick={() => {
                if (selectedDate >= todayKST) return;
                const d = new Date(selectedDate); d.setDate(d.getDate() + 1);
                setSelectedDate(d.toISOString().slice(0, 10)); setCur(0);
              }} disabled={selectedDate >= todayKST}
                className="w-7 h-7 rounded flex items-center justify-center text-text3 hover:bg-hover disabled:opacity-20">
                <ChevronRight size={14} />
              </button>
            </div>
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

          {/* Paper list — equal height rows, no scroll */}
          <div className="flex-1 flex flex-col gap-px px-2 py-1">
            {recs.map((r, i) => (
              <div key={r.id} className="flex-1">
                <ListItem rec={r} index={i} selected={i === cur}
                  onClick={() => { selectPaper(i); openMobile(); }} />
              </div>
            ))}
          </div>

          {/* All done */}
          {fbCount === recs.length && recs.length > 0 && (
            <div className="px-3 py-2 border-t border-border text-center">
              <span className="text-[0.722rem] font-semibold text-success">All done for today!</span>
            </div>
          )}
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

      {/* Toast notification */}
      {toast && <Toast message={toast.message} onUndo={toast.onUndo} onDismiss={() => setToast(null)} />}
    </>
  );
}
