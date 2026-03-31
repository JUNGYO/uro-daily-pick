import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import { Heart, X, ChevronRight, Loader2 } from "lucide-react";

const TYPE_LABELS = {
  rct: "Clinical Trial (RCT)",
  basic_research: "Basic Research",
  biomarker: "Biomarker Study",
  retrospective: "Retrospective Analysis",
  prospective: "Prospective Study",
  meta_analysis: "Meta-analysis / Systematic Review",
  ai_ml: "AI / Machine Learning",
  surgical: "Surgical Technique",
  imaging: "Imaging Study",
  epidemiology: "Epidemiology",
  guideline: "Guideline",
  review: "Review",
  case_report: "Case Report",
};

const TYPE_DESC = {
  rct: "Randomized controlled trials, phase II/III studies",
  basic_research: "In vitro, animal models, molecular biology",
  biomarker: "Biomarker discovery, prognostic/predictive markers, liquid biopsy",
  retrospective: "Retrospective cohort analysis, database studies",
  prospective: "Prospective observational studies",
  meta_analysis: "Systematic reviews and meta-analyses",
  ai_ml: "Machine learning, deep learning, clinical AI",
  surgical: "Surgical techniques, robotic surgery outcomes",
  imaging: "MRI, CT, radiomics, imaging biomarkers",
  epidemiology: "Incidence, prevalence, population trends",
  guideline: "Clinical guidelines, consensus statements",
  review: "Narrative reviews, expert opinions",
  case_report: "Case reports and case series",
};

export default function Onboarding() {
  const { user, loadProfile } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0); // 0: type selection, 1: paper rating
  const [selectedTypes, setSelectedTypes] = useState(new Set());
  const [papers, setPapers] = useState([]);
  const [ratings, setRatings] = useState({}); // paper_id -> "like" | "dislike"
  const [curPaper, setCurPaper] = useState(0);
  const [loading, setLoading] = useState(false);

  const allTypes = Object.keys(TYPE_LABELS);

  const toggleType = (t) => {
    const next = new Set(selectedTypes);
    if (next.has(t)) next.delete(t); else next.add(t);
    setSelectedTypes(next);
  };

  const goToStep2 = async () => {
    if (selectedTypes.size === 0) return;
    setLoading(true);

    // Save preferred study types
    await supabase.from("profiles").update({
      preferred_study_types: [...selectedTypes],
    }).eq("id", user.id);

    // Fetch sample papers from selected types (2 per type, max 10)
    const types = [...selectedTypes];
    let allPapers = [];
    for (const t of types) {
      const { data } = await supabase
        .from("papers")
        .select("id,pmid,title,abstract,journal,pub_date,study_type,authors")
        .eq("study_type", t)
        .order("pub_date", { ascending: false })
        .limit(2);
      if (data) allPapers.push(...data);
    }
    // Shuffle and limit to 10
    allPapers.sort(() => Math.random() - 0.5);
    setPapers(allPapers.slice(0, 10));
    setCurPaper(0);
    setStep(1);
    setLoading(false);
  };

  const ratePaper = async (action) => {
    const paper = papers[curPaper];
    if (!paper) return;
    setRatings(prev => ({ ...prev, [paper.id]: action }));

    // Save feedback
    await supabase.rpc("upsert_feedback", {
      p_user_id: user.id, p_paper_id: paper.id, p_action: action,
    });

    if (curPaper < papers.length - 1) {
      setCurPaper(curPaper + 1);
    }
  };

  const finish = async () => {
    await supabase.from("profiles").update({ onboarding_done: true }).eq("id", user.id);
    await loadProfile(user.id);
    navigate("/");
  };

  const ratedCount = Object.keys(ratings).length;
  const canFinish = ratedCount >= 5;

  // Step 0: Select study types
  if (step === 0) return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-8">
      <div className="w-full max-w-[640px]">
        <div className="text-center mb-10">
          <h1 className="text-[1.556rem] font-bold text-text1">What kind of research interests you?</h1>
          <p className="text-[0.889rem] text-text3 mt-2">Select the study types you want to see. This helps personalize your recommendations.</p>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-8">
          {allTypes.map(t => {
            const active = selectedTypes.has(t);
            return (
              <button key={t} onClick={() => toggleType(t)}
                className={`text-left p-4 rounded-xl border transition-all
                  ${active ? "border-accent bg-[rgba(0,122,255,0.06)]" : "border-border bg-card hover:border-text3"}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[0.889rem] font-semibold text-text1">{TYPE_LABELS[t]}</span>
                  {active && <div className="w-5 h-5 rounded-full bg-accent flex items-center justify-center">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round"><path d="M5 13l4 4L19 7"/></svg>
                  </div>}
                </div>
                <p className="text-[0.778rem] text-text3 leading-snug">{TYPE_DESC[t]}</p>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[0.889rem] text-text3">{selectedTypes.size} selected</span>
          <button onClick={goToStep2} disabled={selectedTypes.size === 0 || loading}
            className="flex items-center gap-2 h-11 px-6 bg-accent text-white rounded-lg text-[0.889rem] font-semibold disabled:opacity-40 hover:bg-[#0066D6] transition-colors">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <>Next <ChevronRight size={16} /></>}
          </button>
        </div>
      </div>
    </div>
  );

  // Step 1: Rate papers
  const paper = papers[curPaper];
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-8">
      <div className="w-full max-w-[600px]">
        <div className="text-center mb-6">
          <h1 className="text-[1.333rem] font-bold text-text1">Rate these papers</h1>
          <p className="text-[0.889rem] text-text3 mt-1">Like papers you'd read. Skip ones you wouldn't. This trains your recommendations.</p>
        </div>

        {/* Progress */}
        <div className="flex gap-1 mb-6">
          {papers.map((_, i) => (
            <div key={i} className="flex-1 h-1 rounded-full transition-colors"
              style={{ background: i === curPaper ? "#007AFF" : ratings[papers[i]?.id] === "like" ? "#34C759" : ratings[papers[i]?.id] === "dislike" ? "#E5E5EA" : "#E5E5EA" }} />
          ))}
        </div>

        {paper && (
          <div className="bg-card rounded-xl border border-border p-6 mb-6" style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[0.778rem] font-semibold text-accent">{paper.journal}</span>
              <span className="w-1 h-1 rounded-full bg-border" />
              <span className="text-[0.778rem] text-text3">{paper.pub_date}</span>
              <span className="text-[0.667rem] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-hover text-text3 border border-border ml-auto">
                {TYPE_LABELS[paper.study_type] || paper.study_type}
              </span>
            </div>
            <h2 className="text-[1.111rem] font-bold text-text1 leading-snug mb-3">{paper.title}</h2>
            <p className="text-[0.833rem] text-text2 mb-3">
              {(paper.authors || []).slice(0, 3).join(", ")}
              {paper.authors?.length > 3 && <span className="text-text3"> et al.</span>}
            </p>
            {paper.abstract && (
              <p className="text-[0.833rem] text-text3 leading-relaxed" style={{ display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {paper.abstract}
              </p>
            )}
          </div>
        )}

        <div className="flex items-center justify-center gap-6 mb-6">
          <button onClick={() => ratePaper("dislike")}
            className="w-14 h-14 rounded-full border-2 border-border flex items-center justify-center text-text3 hover:border-danger hover:text-danger hover:bg-[rgba(255,59,48,0.04)] transition-all">
            <X size={24} />
          </button>
          <span className="text-[0.889rem] text-text3 font-mono">{curPaper + 1} / {papers.length}</span>
          <button onClick={() => ratePaper("like")}
            className="w-14 h-14 rounded-full border-2 border-border flex items-center justify-center text-text3 hover:border-success hover:text-success hover:bg-[rgba(52,199,89,0.04)] transition-all">
            <Heart size={24} />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[0.889rem] text-text3">{ratedCount} rated{canFinish ? " — ready!" : ` — rate ${5 - ratedCount} more`}</span>
          <button onClick={finish} disabled={!canFinish}
            className="h-11 px-6 bg-accent text-white rounded-lg text-[0.889rem] font-semibold disabled:opacity-30 hover:bg-[#0066D6] transition-colors">
            Start Daily Pick
          </button>
        </div>
      </div>
    </div>
  );
}
