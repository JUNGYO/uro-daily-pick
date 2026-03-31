import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://vwdcqzcoovczmtzdyzbc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_FwZC-M2lO2nvh3MFbqf6nA_K8jMXNdw";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
