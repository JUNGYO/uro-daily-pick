import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate } from "react-router-dom";
import { lazy, Suspense, Component, useState } from "react";
import { AuthProvider, useAuth } from "./lib/auth";
import { Loading, ErrorNotice } from "./components/Status";
export { useAuth } from "./lib/auth";
import { supabase } from "./lib/supabase";
const DailyPick = lazy(() => import("./pages/DailyPick"));
const Collections = lazy(() => import("./pages/Collections"));
const Settings = lazy(() => import("./pages/Settings"));
const Login = lazy(() => import("./pages/Login"));
const Onboarding = lazy(() => import("./pages/Onboarding"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const Landing = lazy(() => import("./pages/Landing"));
const Insights = lazy(() => import("./pages/Insights"));
const Admin = lazy(() => import("./pages/Admin"));
const Privacy = lazy(() => import("./pages/Privacy"));
const FullText = lazy(() => import("./pages/FullText"));
import { Newspaper, FolderOpen, Settings as SettingsIcon, LogOut, Network, BarChart3 } from "lucide-react";

const ADMIN_EMAILS = ["crazyslime@gmail.com"];

function ProtectedRoute({ children, onboarding = false }) {
  const { user, profile, loading, error, retry } = useAuth();
  if (loading) return <Loading text="Preparing your workspace…" />;
  if (error)
    return (
      <div className="max-w-lg mx-auto p-6">
        <ErrorNotice message={error} onRetry={retry} />
      </div>
    );
  if (!user) return <Navigate to="/welcome" replace />;
  if (!profile) return <ErrorNotice message="Your profile is unavailable." onRetry={retry} />;
  if (!onboarding && !profile.onboarding_done) return <Navigate to="/onboarding" replace />;
  if (onboarding && profile.onboarding_done) return <Navigate to="/" replace />;
  return children;
}

function Layout({ children }) {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [logoutError, setLogoutError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);

  const logout = async () => {
    setLoggingOut(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      navigate("/login", { replace: true });
    } catch {
      setLogoutError("Could not sign out. Please retry.");
    } finally {
      setLoggingOut(false);
    }
  };

  const isAdmin = ADMIN_EMAILS.includes(user?.email?.trim().toLowerCase());
  const links = [
    { to: "/", icon: Newspaper, label: "Daily Pick" },
    { to: "/insights", icon: Network, label: "Insights" },
    { to: "/collections", icon: FolderOpen, label: "Collections" },
    { to: "/settings", icon: SettingsIcon, label: "Settings" },
    ...(isAdmin ? [{ to: "/admin", icon: BarChart3, label: "Admin" }] : []),
  ];

  return (
    <div className="h-dvh bg-bg text-text1 flex flex-col overflow-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:bg-white focus:p-3"
      >
        Skip to content
      </a>
      {/* Header */}
      <header className="h-12 md:h-14 flex items-center justify-between px-4 md:px-8 bg-card border-b border-border shrink-0 sticky top-0 z-50">
        <div className="flex items-center gap-2">
          <svg
            width="20"
            height="20"
            viewBox="0 0 80 80"
            fill="none"
            className="shrink-0 md:w-[22px] md:h-[22px]"
          >
            <polygon points="40,4 72,22 72,58 40,76 8,58 8,22" fill="none" stroke="#1D1D1F" strokeWidth="2" />
            <line x1="40" y1="40" x2="40" y2="4.5" stroke="#0066CC" strokeWidth="1.5" />
            <line x1="40" y1="40" x2="8.5" y2="58.5" stroke="#0066CC" strokeWidth="1.5" />
            <line x1="40" y1="40" x2="71.5" y2="58.5" stroke="#0066CC" strokeWidth="1.5" />
            <circle cx="40" cy="40" r="5" fill="#1D1D1F" />
            <circle cx="40" cy="4" r="4" fill="none" stroke="#0066CC" strokeWidth="2" />
            <circle cx="8" cy="58" r="4" fill="none" stroke="#0066CC" strokeWidth="2" />
            <circle cx="72" cy="58" r="4" fill="none" stroke="#0066CC" strokeWidth="2" />
          </svg>
          <span className="text-[0.778rem] md:text-[1.111rem] font-bold tracking-tight">Uro Daily Pick</span>
        </div>
        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1">
          {links.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-1.5 h-9 px-4 rounded-lg text-[0.889rem] font-medium transition-colors
                 ${isActive ? "bg-[rgba(0,122,255,0.08)] text-accent" : "text-text3 hover:bg-hover"}`
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2 md:gap-4">
          <span className="text-[0.778rem] text-text3 hidden md:inline">{profile?.name || user?.email}</span>
          <button
            onClick={logout}
            disabled={loggingOut}
            className="h-8 px-3 rounded-lg flex items-center gap-1.5 text-text3 hover:bg-hover transition-colors text-[0.722rem]"
            aria-label="Logout"
          >
            <LogOut size={15} />
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </header>

      {logoutError && <ErrorNotice message={logoutError} onRetry={logout} />}
      <main id="main-content" tabIndex={-1} className="flex-1 min-h-0 overflow-hidden pb-16 md:pb-0">
        {children}
      </main>

      {/* Mobile bottom tab bar */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-card/95 backdrop-blur border-t border-border flex items-stretch justify-around"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {links.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-0.5 py-2 px-3 min-w-[64px] transition-colors
               ${isActive ? "text-accent" : "text-text3"}`
            }
          >
            <Icon size={20} />
            <span className="text-[0.611rem] font-medium">{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-bg">
          <div className="text-center">
            <p className="text-[1rem] text-text1 mb-2">Something went wrong</p>
            <button
              onClick={() => window.location.reload()}
              className="h-10 px-5 bg-accent text-white rounded-lg text-[0.889rem] font-medium"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "") || "/"}>
      <ErrorBoundary>
        <AuthProvider>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/welcome" element={<Landing />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/login" element={<Login />} />
              <Route
                path="/onboarding"
                element={
                  <ProtectedRoute onboarding>
                    <Onboarding />
                  </ProtectedRoute>
                }
              />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route
                path="/*"
                element={
                  <ProtectedRoute>
                    <Layout>
                      <Routes>
                        <Route path="/" element={<DailyPick />} />
                        <Route path="/insights" element={<Insights />} />
                        <Route path="/collections" element={<Collections />} />
                        <Route path="/settings" element={<Settings />} />
                        <Route path="/admin" element={<Admin />} />
                        <Route path="/fulltext/:pmid" element={<FullText />} />
                        <Route
                          path="*"
                          element={
                            <div className="p-8">
                              <h1 className="text-xl font-semibold">Page not found</h1>
                              <NavLink to="/" className="text-accent underline">
                                Back to Daily Pick
                              </NavLink>
                            </div>
                          }
                        />
                      </Routes>
                    </Layout>
                  </ProtectedRoute>
                }
              />
            </Routes>
          </Suspense>
        </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
