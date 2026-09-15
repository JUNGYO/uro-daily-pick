import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";
import { checked, withTimeout } from "./data";

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

function clearResearchDrafts(uid) {
  try {
    const prefix = "uro-research-draft:" + (uid ? uid + ":" : "");
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  } catch {
    /* Draft storage must not prevent an account change. */
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const currentUser = useRef(null);
  const profileRequest = useRef(0);
  useEffect(() => {
    const reconnect = () => setRevision((n) => n + 1);
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, []);

  useEffect(() => {
    let disposed = false,
      offlineMode = false,
      authEvents = 0;
    setAuthLoading(true);
    const apply = (session) => {
      if (!disposed) {
        if (currentUser.current && currentUser.current !== session?.user?.id) {
          clearResearchDrafts(currentUser.current);
        }
        currentUser.current = session?.user?.id;
        setUser(session?.user ?? null);
        setAuthLoading(false);
      }
    };
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (offlineMode && _event !== "SIGNED_OUT") return;
      // Also handles account deletion and sign-out initiated outside the header.
      if (_event === "SIGNED_OUT") {
        clearResearchDrafts();
        try {
          const uid = currentUser.current || localStorage.getItem("uro-offline-active");
          if (uid) {
            localStorage.removeItem("uro-offline:" + uid);
            localStorage.removeItem("uro-profile:" + uid);
          }
          localStorage.removeItem("uro-offline-active");
        } catch {
          /* Storage failure must not prevent session termination. */
        }
      }
      authEvents += 1;
      apply(session);
    });
    // Offline identity only opens device summaries. It is never an API credential.
    try {
      const uid = localStorage.getItem("uro-offline-active");
      if (!navigator.onLine && uid && JSON.parse(localStorage.getItem("uro-offline:" + uid) || "[]").length) {
        offlineMode = true;
        apply({ user: { id: uid, offline: true } });
        return () => {
          disposed = true;
          subscription.unsubscribe();
        };
      }
    } catch {
      /* Continue to login when device storage is unavailable. */
    }
    withTimeout(supabase.auth.getSession())
      .then(({ data, error }) => {
        if (error) throw error;
        if (!authEvents) apply(data.session);
      })
      .catch(() => {
        if (!disposed && !authEvents) {
          setError("Could not restore your session.");
          setAuthLoading(false);
        }
      });
    return () => {
      disposed = true;
      subscription.unsubscribe();
    };
  }, [revision]);

  const loadProfile = useCallback(async (uid) => {
    const request = ++profileRequest.current;
    let data;
    if (!navigator.onLine && localStorage.getItem("uro-offline:" + uid)) {
      data = JSON.parse(localStorage.getItem("uro-profile:" + uid) || "null");
    } else {
      data = await withTimeout(checked(supabase.from("profiles").select("*").eq("id", uid).single()));
      try {
        if (data)
          localStorage.setItem(
            "uro-profile:" + uid,
            JSON.stringify({ id: data.id, name: data.name, onboarding_done: data.onboarding_done }),
          );
      } catch {
        /* Storage limits must not break a valid login. */
      }
    }
    if (!data) throw new Error("Profile is unavailable.");
    if (currentUser.current === uid && request === profileRequest.current) setProfile(data);
    return data;
  }, []);

  useEffect(() => {
    let disposed = false;
    setProfile(null);
    setError("");
    if (!user?.id) {
      setProfileLoading(false);
      return;
    }
    setProfileLoading(true);
    loadProfile(user.id)
      .catch(() => {
        if (!disposed) setError("Could not load your profile. Please retry.");
      })
      .finally(() => {
        if (!disposed) setProfileLoading(false);
      });
    return () => {
      disposed = true;
      profileRequest.current += 1;
    };
  }, [user?.id, revision, loadProfile]);

  const ownProfile = profile?.id === user?.id ? profile : null;
  return (
    <AuthContext.Provider
      value={{
        user,
        profile: ownProfile,
        setProfile,
        loadProfile,
        loading: authLoading || profileLoading || (Boolean(user) && !ownProfile && !error),
        error,
        retry: () => {
          setError("");
          setRevision((value) => value + 1);
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
