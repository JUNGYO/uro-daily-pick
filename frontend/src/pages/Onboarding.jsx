import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import { ChevronRight, Loader2, X, Plus } from "lucide-react";

const CATEGORIES = [
  {
    label: "Oncology",
    keywords: ["prostate cancer", "bladder cancer", "kidney cancer", "testicular cancer", "upper tract urothelial carcinoma", "immunotherapy", "targeted therapy"],
  },
  {
    label: "Endourology & Stones",
    keywords: ["urolithiasis", "stone disease", "PCNL", "ureteroscopy", "shock wave lithotripsy", "metabolic stone evaluation"],
  },
  {
    label: "Functional & Female",
    keywords: ["overactive bladder", "BPH", "neurogenic bladder", "incontinence", "pelvic organ prolapse", "urodynamics"],
  },
  {
    label: "Surgery & Technology",
    keywords: ["robotic surgery", "minimally invasive surgery", "laparoscopy", "surgical technique", "3D printing", "AI"],
  },
  {
    label: "Transplant & Reconstruction",
    keywords: ["kidney transplant", "urinary diversion", "urethroplasty", "reconstructive urology"],
  },
  {
    label: "Research Methods",
    keywords: ["biomarker", "genomics", "clinical trial", "meta-analysis", "epidemiology", "machine learning"],
  },
];

export default function Onboarding() {
  const { user, loadProfile } = useAuth();
  const navigate = useNavigate();
  const [keywords, setKeywords] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const toggle = (kw) => {
    setKeywords(prev => prev.includes(kw) ? prev.filter(k => k !== kw) : [...prev, kw]);
  };

  const addCustom = (val) => {
    const trimmed = val.trim();
    if (trimmed && !keywords.includes(trimmed)) setKeywords([...keywords, trimmed]);
    setInput("");
  };

  const finish = async () => {
    if (keywords.length < 1) return;
    setLoading(true);
    await supabase.from("profiles").update({
      keywords,
      onboarding_done: true,
    }).eq("id", user.id);
    await loadProfile(user.id);
    setLoading(false);
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-6">
      <div className="w-full max-w-[560px]">
        <div className="text-center mb-8">
          <svg width="40" height="40" viewBox="0 0 80 80" fill="none" className="mx-auto mb-4">
            <polygon points="40,4 72,22 72,58 40,76 8,58 8,22" fill="none" stroke="#1D1D1F" strokeWidth="1.5"/>
            <line x1="40" y1="40" x2="40" y2="4.5" stroke="#007AFF" strokeWidth="1.2"/>
            <line x1="40" y1="40" x2="8.5" y2="58.5" stroke="#007AFF" strokeWidth="1.2"/>
            <line x1="40" y1="40" x2="71.5" y2="58.5" stroke="#007AFF" strokeWidth="1.2"/>
            <circle cx="40" cy="40" r="5" fill="#1D1D1F"/>
            <circle cx="40" cy="4" r="4" fill="none" stroke="#007AFF" strokeWidth="1.8"/>
            <circle cx="8" cy="58" r="4" fill="none" stroke="#007AFF" strokeWidth="1.8"/>
            <circle cx="72" cy="58" r="4" fill="none" stroke="#007AFF" strokeWidth="1.8"/>
          </svg>
          <h1 className="text-[1.333rem] font-bold text-text1">What do you research?</h1>
          <p className="text-[0.889rem] text-text3 mt-2">Select topics to personalize your daily picks.</p>
        </div>

        <div className="bg-card rounded-xl border border-border p-5 sm:p-6" style={{ boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}>
          {/* Category sections */}
          {CATEGORIES.map(cat => (
            <div key={cat.label} className="mb-5 last:mb-0">
              <p className="text-[0.722rem] font-semibold text-text3 uppercase tracking-wider mb-2">{cat.label}</p>
              <div className="flex flex-wrap gap-1.5">
                {cat.keywords.map(kw => {
                  const active = keywords.includes(kw);
                  return (
                    <button key={kw} onClick={() => toggle(kw)} type="button"
                      className={`h-8 px-3 rounded-lg text-[0.778rem] font-medium border transition-all duration-150
                        ${active
                          ? "bg-[rgba(0,122,255,0.08)] text-accent border-accent"
                          : "bg-card text-text2 border-border hover:border-text3 hover:bg-hover"}`}>
                      {active ? "✓ " : ""}{kw}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Custom keyword input */}
          <div className="mt-5 pt-5 border-t border-border">
            <p className="text-[0.722rem] font-semibold text-text3 uppercase tracking-wider mb-2">Or add your own</p>
            <div className="flex gap-2">
              <input value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addCustom(input); } }}
                placeholder="Type a keyword"
                className="flex-1 h-10 bg-bg border border-border rounded-lg px-4 text-[0.833rem] text-text1 outline-none focus:border-accent transition-colors" />
              <button onClick={() => addCustom(input)} disabled={!input.trim()}
                className="h-10 px-3 bg-hover border border-border rounded-lg hover:bg-border transition-colors disabled:opacity-30">
                <Plus size={16} className="text-text3" />
              </button>
            </div>
          </div>

          {/* Selected summary */}
          {keywords.some(kw => !CATEGORIES.flatMap(c => c.keywords).includes(kw)) && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {keywords.filter(kw => !CATEGORIES.flatMap(c => c.keywords).includes(kw)).map(kw => (
                <span key={kw} className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg bg-[rgba(0,122,255,0.06)] text-accent text-[0.778rem] font-medium border border-[rgba(0,122,255,0.12)]">
                  {kw}
                  <button onClick={() => setKeywords(keywords.filter(k => k !== kw))} className="hover:text-danger"><X size={13} /></button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between mt-6">
          <span className="text-[0.833rem] text-text3">
            {keywords.length === 0 ? "Select at least 1 topic" : `${keywords.length} selected`}
          </span>
          <button onClick={finish} disabled={keywords.length < 1 || loading}
            className="flex items-center gap-2 h-11 px-6 bg-accent text-white rounded-lg text-[0.889rem] font-semibold disabled:opacity-40 hover:bg-[#0066D6] transition-colors">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <>Start <ChevronRight size={16} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
