import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate } from "react-router-dom";
import { useState, useEffect, createContext, useContext } from "react";
import { supabase } from "./lib/supabase";
import DailyPick from "./pages/DailyPick";
import Collections from "./pages/Collections";
import Settings from "./pages/Settings";
import Login from "./pages/Login";
import { Newspaper, FolderOpen, Settings as SettingsIcon, LogOut } from "lucide-react";

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (session?.user) loadProfile(session.user.id);
      else setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) loadProfile(session.user.id);
      else { setProfile(null); setLoading(false); }
    });

    return () => subscription.unsubscribe();
  }, []);

  const loadProfile = async (uid) => {
    const { data } = await supabase.from("profiles").select("*").eq("id", uid).single();
    setProfile(data);
    setLoading(false);
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-bg text-text3 text-lg">Loading...</div>;

  return <AuthContext.Provider value={{ user, profile, setProfile, loadProfile }}>{children}</AuthContext.Provider>;
}

function ProtectedRoute({ children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" />;
  return children;
}

function Layout({ children }) {
  const { user, profile } = useAuth();
  const navigate = useNavigate();

  const logout = async () => {
    await supabase.auth.signOut();
    navigate("/login");
  };

  const links = [
    { to: "/", icon: Newspaper, label: "Daily Pick" },
    { to: "/collections", icon: FolderOpen, label: "Collections" },
    { to: "/settings", icon: SettingsIcon, label: "Settings" },
  ];

  return (
    <div className="min-h-screen bg-bg text-text1 flex flex-col">
      <header className="h-14 flex items-center justify-between px-8 bg-card border-b border-border shrink-0 sticky top-0 z-50">
        <div className="flex items-center gap-2.5">
          <svg width="24" height="24" viewBox="0 0 80 80" fill="none">
            <polygon points="40,4 72,22 72,58 40,76 8,58 8,22" fill="none" stroke="#1D1D1F" strokeWidth="2"/>
            <line x1="40" y1="40" x2="40" y2="4.5"   stroke="#007AFF" strokeWidth="1.5"/>
            <line x1="40" y1="40" x2="8.5"  y2="58.5" stroke="#007AFF" strokeWidth="1.5"/>
            <line x1="40" y1="40" x2="71.5" y2="58.5" stroke="#007AFF" strokeWidth="1.5"/>
            <circle cx="40" cy="40" r="5" fill="#1D1D1F"/>
            <circle cx="40" cy="4"  r="4" fill="none" stroke="#007AFF" strokeWidth="2"/>
            <circle cx="8"  cy="58" r="4" fill="none" stroke="#007AFF" strokeWidth="2"/>
            <circle cx="72" cy="58" r="4" fill="none" stroke="#007AFF" strokeWidth="2"/>
          </svg>
          <span className="text-[1.222rem] font-bold tracking-tight">Uro Daily Pick</span>
        </div>
        <nav className="flex items-center gap-1">
          {links.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-1.5 h-9 px-4 rounded-lg text-[0.889rem] font-medium transition-colors
                 ${isActive ? "bg-[rgba(0,122,255,0.08)] text-accent" : "text-text3 hover:bg-hover"}`
              }>
              <Icon size={18} />{label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-4">
          <span className="text-[0.889rem] text-text3">{profile?.name || user?.email}</span>
          <button onClick={logout} className="w-9 h-9 rounded-lg flex items-center justify-center text-text3 hover:bg-hover transition-colors">
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter basename="/uro-daily-pick">
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/*" element={
            <ProtectedRoute><Layout>
              <Routes>
                <Route path="/" element={<DailyPick />} />
                <Route path="/collections" element={<Collections />} />
                <Route path="/settings" element={<Settings />} />
              </Routes>
            </Layout></ProtectedRoute>
          } />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
