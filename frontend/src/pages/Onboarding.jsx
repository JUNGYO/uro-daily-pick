import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../App";
import { ChevronRight, Loader2, X, Plus } from "lucide-react";

const SUGGESTED = ["prostate cancer", "bladder cancer", "kidney cancer", "robotic surgery", "BPH", "immunotherapy", "biomarker", "AI", "stone disease", "transplant"];

export default function Onboarding() {
  const { user, loadProfile } = useAuth();
  const navigate = useNavigate();
  const [keywords, setKeywords] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const addKeyword = (kw) => {
    const trimmed = kw.trim();
    if (trimmed && !keywords.includes(trimmed)) setKeywords([...keywords, trimmed]);
    setInput("");
  };

  const removeKeyword = (kw) => setKeywords(keywords.filter(k => k !== kw));

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
    <div className="min-h-screen bg-bg flex items-center justify-center p-8">
      <div className="w-full max-w-[480px]">
        <div className="text-center mb-10">
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
          <p className="text-[0.889rem] text-text3 mt-2">Add your research interests. We'll personalize your daily picks.</p>
        </div>

        <div className="bg-card rounded-xl border border-border p-6" style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
          {/* Selected keywords */}
          {keywords.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {keywords.map(kw => (
                <span key={kw} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[rgba(0,122,255,0.06)] text-accent text-[0.833rem] font-medium border border-[rgba(0,122,255,0.12)]">
                  {kw}
                  <button onClick={() => removeKeyword(kw)} className="hover:text-danger"><X size={14} /></button>
                </span>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="flex gap-2 mb-5">
            <input value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addKeyword(input); } }}
              placeholder="Type a keyword and press Enter"
              className="flex-1 h-11 bg-bg border border-border rounded-lg px-4 text-[0.889rem] text-text1 outline-none focus:border-accent transition-colors" />
            <button onClick={() => addKeyword(input)} disabled={!input.trim()}
              className="h-11 px-3 bg-hover border border-border rounded-lg hover:bg-border transition-colors disabled:opacity-30">
              <Plus size={16} className="text-text3" />
            </button>
          </div>

          {/* Suggestions */}
          <div>
            <p className="text-[0.722rem] font-semibold text-text3 uppercase tracking-wider mb-2">Popular in urology</p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTED.filter(s => !keywords.includes(s)).map(s => (
                <button key={s} onClick={() => addKeyword(s)}
                  className="h-7 px-2.5 rounded-md text-[0.722rem] font-medium text-text3 bg-hover border border-border hover:text-accent hover:border-accent transition-colors">
                  + {s}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between mt-6">
          <span className="text-[0.833rem] text-text3">{keywords.length} keyword{keywords.length !== 1 ? "s" : ""} selected</span>
          <button onClick={finish} disabled={keywords.length < 1 || loading}
            className="flex items-center gap-2 h-11 px-6 bg-accent text-white rounded-lg text-[0.889rem] font-semibold disabled:opacity-40 hover:bg-[#0066D6] transition-colors">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <>Start <ChevronRight size={16} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
