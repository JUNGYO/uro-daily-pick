import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Sparkles } from "lucide-react";

export default function Login() {
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      if (isSignup) {
        const { error: signUpError } = await supabase.auth.signUp({
          email, password,
          options: { data: { name } },
        });
        if (signUpError) throw signUpError;
        // Update profile with keywords
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const kws = keywords.split(",").map(k => k.trim()).filter(Boolean);
          await supabase.from("profiles").update({
            name, keywords: kws,
          }).eq("id", user.id);
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      }
      navigate("/");
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const inputCls = "w-full h-12 bg-card border border-border rounded-lg px-4 text-[1rem] text-text1 outline-none focus:border-accent transition-colors";

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-8">
      <div className="w-full max-w-[400px]">
        <div className="text-center mb-12">
          <Sparkles size={32} className="text-accent mx-auto mb-3" />
          <h1 className="text-[1.556rem] font-bold text-text1 tracking-tight">Uro Daily Pick</h1>
          <p className="text-[0.889rem] text-text3 mt-1">Personalized urology paper recommendations</p>
        </div>

        <div className="bg-card rounded-xl border border-border p-8" style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
          <div className="flex rounded-lg border border-border overflow-hidden mb-8">
            {["Sign in", "Sign up"].map((label, i) => (
              <button key={label} onClick={() => setIsSignup(i === 1)}
                className={`flex-1 h-10 text-[0.889rem] font-medium transition-colors
                  ${(i === 0 ? !isSignup : isSignup)
                    ? "bg-[rgba(0,122,255,0.08)] text-accent"
                    : "bg-card text-text3 hover:bg-hover"}`}
                style={{ borderLeft: i === 1 ? "1px solid #E5E5EA" : "none" }}>
                {label}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            {isSignup && (
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" className={inputCls} />
            )}
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" required className={inputCls} />
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password (min 6 chars)" required className={inputCls} />
            {isSignup && (
              <div>
                <input value={keywords} onChange={e => setKeywords(e.target.value)}
                  placeholder="Research interests (comma separated)"
                  className={inputCls} />
                <p className="text-[0.778rem] text-text3 mt-1">e.g. prostate cancer, robotic surgery, BPH</p>
              </div>
            )}
            {error && <p className="text-[0.889rem] text-danger">{error}</p>}
            <button type="submit" disabled={loading}
              className="w-full h-11 rounded-lg bg-accent text-white text-[0.889rem] font-semibold hover:bg-[#0066D6] disabled:opacity-50 transition-colors mt-2">
              {loading ? "..." : isSignup ? "Get started" : "Continue"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
