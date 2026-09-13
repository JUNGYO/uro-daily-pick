import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";
import { checked, withTimeout } from "./data";

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

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
    let disposed = false,
      authEvents = 0;
    setAuthLoading(true);
    const apply = (session) => {
      if (!disposed) {
        currentUser.current = session?.user?.id;
        setUser(session?.user ?? null);
        setAuthLoading(false);
      }
    };
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      authEvents += 1;
      apply(session);
    });
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
    const data = await withTimeout(checked(supabase.from("profiles").select("*").eq("id", uid).single()));
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
