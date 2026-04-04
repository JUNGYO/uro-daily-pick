import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Loader2 } from "lucide-react";

export default function Login() {
  const [mode, setMode] = useState("signin"); // signin | signup | forgot
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const inputCls = "w-full h-12 bg-card border border-border rounded-lg px-4 text-[1rem] text-text1 outline-none focus:border-accent transition-colors";

  const handleSubmit = async (e) => {
    e.preventDefault(); setError(""); setMessage(""); setLoading(true);
    try {
      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/uro-daily-pick/reset-password`,
        });
        if (error) throw error;
        setMessage("Password reset email sent. Check your inbox.");
      } else if (mode === "signup") {
        const { error: signUpError } = await supabase.auth.signUp({
          email, password,
          options: { data: { name } },
        });
        if (signUpError) throw signUpError;
        if (name) {
          const { data: { user } } = await supabase.auth.getUser();
          if (user) await supabase.from("profiles").update({ name }).eq("id", user.id);
        }
        navigate("/");
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
        navigate("/");
      }
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-8">
      <div className="w-full max-w-[400px]">
        <div className="text-center mb-12">
          <svg width="48" height="48" viewBox="0 0 80 80" fill="none" className="mx-auto mb-4">
            <polygon points="40,4 72,22 72,58 40,76 8,58 8,22" fill="none" stroke="#1D1D1F" strokeWidth="1.5"/>
            <line x1="40" y1="40" x2="40" y2="4.5" stroke="#007AFF" strokeWidth="1.2"/>
            <line x1="40" y1="40" x2="8.5" y2="58.5" stroke="#007AFF" strokeWidth="1.2"/>
            <line x1="40" y1="40" x2="71.5" y2="58.5" stroke="#007AFF" strokeWidth="1.2"/>
            <circle cx="40" cy="40" r="5" fill="#1D1D1F"/>
            <circle cx="40" cy="4" r="4" fill="none" stroke="#007AFF" strokeWidth="1.8"/>
            <circle cx="8" cy="58" r="4" fill="none" stroke="#007AFF" strokeWidth="1.8"/>
            <circle cx="72" cy="58" r="4" fill="none" stroke="#007AFF" strokeWidth="1.8"/>
          </svg>
          <h1 className="text-[1.556rem] font-bold text-text1 tracking-tight">Uro Daily Pick</h1>
          <p className="text-[0.889rem] text-text3 mt-1">Personalized urology paper recommendations</p>
        </div>

        <div className="bg-card rounded-xl border border-border p-8" style={{ boxShadow: "0 4px 24px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)" }}>
          {mode !== "forgot" && (
            <div className="flex rounded-lg border border-border overflow-hidden mb-8">
              {["Sign in", "Sign up"].map((label, i) => (
                <button key={label} onClick={() => { setMode(i === 0 ? "signin" : "signup"); setError(""); setMessage(""); }}
                  className={`flex-1 h-10 text-[0.889rem] font-medium transition-colors
                    ${(i === 0 ? mode === "signin" : mode === "signup")
                      ? "bg-[rgba(0,122,255,0.08)] text-accent"
                      : "bg-card text-text3 hover:bg-hover"}`}
                  style={{ borderLeft: i === 1 ? "1px solid #E5E5EA" : "none" }}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {mode === "forgot" && (
            <div className="mb-6">
              <h2 className="text-[1.111rem] font-bold text-text1 mb-1">Reset password</h2>
              <p className="text-[0.889rem] text-text3">Enter your email and we'll send a reset link.</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            {mode === "signup" && (
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" className={inputCls} />
            )}
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" required className={inputCls} />
            {mode !== "forgot" && (
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password (min 6 chars)" required className={inputCls} />
            )}


            {error && <p className="text-[0.833rem] text-danger bg-[rgba(255,59,48,0.06)] border border-[rgba(255,59,48,0.12)] rounded-lg px-3 py-2">{error}</p>}
            {message && <p className="text-[0.833rem] text-success bg-[rgba(52,199,89,0.06)] border border-[rgba(52,199,89,0.12)] rounded-lg px-3 py-2">{message}</p>}

            <button type="submit" disabled={loading}
              className="w-full h-11 rounded-lg bg-accent text-white text-[0.889rem] font-semibold hover:bg-[#0066D6] disabled:opacity-50 transition-colors mt-2">
              {loading ? <Loader2 size={16} className="animate-spin" /> : mode === "forgot" ? "Send reset link" : mode === "signup" ? "Get started" : "Continue"}
            </button>
          </form>

          <div className="mt-4 text-center">
            {mode === "forgot" ? (
              <button onClick={() => { setMode("signin"); setError(""); setMessage(""); }}
                className="text-[0.889rem] text-accent hover:underline">Back to sign in</button>
            ) : (
              <button onClick={() => { setMode("forgot"); setError(""); setMessage(""); }}
                className="text-[0.889rem] text-text3 hover:text-accent">Forgot password?</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
