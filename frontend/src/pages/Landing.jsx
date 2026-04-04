import { useNavigate } from "react-router-dom";
import { Sparkles, Languages, BookOpen } from "lucide-react";

export default function Landing() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-bg">
      {/* Hero */}
      <div className="max-w-[640px] mx-auto px-6 pt-20 pb-16 text-center">
        <svg width="56" height="56" viewBox="0 0 80 80" fill="none" className="mx-auto mb-6">
          <polygon points="40,4 72,22 72,58 40,76 8,58 8,22" fill="none" stroke="#1D1D1F" strokeWidth="1.5"/>
          <line x1="40" y1="40" x2="40" y2="4.5" stroke="#007AFF" strokeWidth="1.2"/>
          <line x1="40" y1="40" x2="8.5" y2="58.5" stroke="#007AFF" strokeWidth="1.2"/>
          <line x1="40" y1="40" x2="71.5" y2="58.5" stroke="#007AFF" strokeWidth="1.2"/>
          <circle cx="40" cy="40" r="5" fill="#1D1D1F"/>
          <circle cx="40" cy="4" r="4" fill="none" stroke="#007AFF" strokeWidth="1.8"/>
          <circle cx="8" cy="58" r="4" fill="none" stroke="#007AFF" strokeWidth="1.8"/>
          <circle cx="72" cy="58" r="4" fill="none" stroke="#007AFF" strokeWidth="1.8"/>
        </svg>
        <h1 className="text-[2rem] font-bold text-text1 tracking-tight leading-tight mb-4">
          Uro Daily Pick
        </h1>
        <p className="text-[1.111rem] text-text2 leading-relaxed mb-8">
          매일 아침, 당신의 연구 관심사에 맞는<br/>
          비뇨기과 논문 5편을 골라드립니다.
        </p>
        <div className="flex items-center justify-center gap-3">
          <button onClick={() => navigate("/login")}
            className="h-12 px-8 bg-accent text-white rounded-xl text-[0.889rem] font-semibold hover:bg-[#0066D6] transition-colors">
            Get Started
          </button>
          <button onClick={() => navigate("/login")}
            className="h-12 px-8 border border-border text-text2 rounded-xl text-[0.889rem] font-medium hover:bg-hover transition-colors">
            Sign In
          </button>
        </div>
      </div>

      {/* Features */}
      <div className="max-w-[720px] mx-auto px-6 pb-20">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            { icon: Sparkles, color: "#007AFF", bg: "rgba(0,122,255,0.08)", title: "Personalized", desc: "키워드, 저널 선호, 좋아요 이력으로 당신만의 추천을 생성합니다." },
            { icon: Languages, color: "#34C759", bg: "rgba(52,199,89,0.08)", title: "한글 요약", desc: "AI가 논문을 3문장 한글로 요약합니다. 30초에 핵심을 파악하세요." },
            { icon: BookOpen, color: "#FF9500", bg: "rgba(255,149,0,0.08)", title: "Major Journals", desc: "European Urology, JCO, Lancet 등 30개 메이저 저널만 수집합니다." },
          ].map(f => (
            <div key={f.title} className="bg-card rounded-xl border border-border p-5 hover:shadow-md transition-shadow" style={{ boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ background: f.bg }}>
                <f.icon size={20} style={{ color: f.color }} />
              </div>
              <h3 className="text-[0.889rem] font-semibold text-text1 mb-2">{f.title}</h3>
              <p className="text-[0.778rem] text-text3 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>

        <div className="mt-12 text-center">
          <p className="text-[0.778rem] text-text3">
            CIPHER Lab · Dept. of Urology · Asan Medical Center
          </p>
        </div>
      </div>
    </div>
  );
}
