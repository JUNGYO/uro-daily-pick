import { createClient } from "@supabase/supabase-js";

// The fallback is the existing production public key. Never put service-role keys in VITE_*.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://vwdcqzcoovczmtzdyzbc.supabase.co";
const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_FwZC-M2lO2nvh3MFbqf6nA_K8jMXNdw";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
