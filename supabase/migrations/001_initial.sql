-- ═══════════════════════════════════════════════════
--  Uro Daily Pick — Initial Schema
-- ═══════════════════════════════════════════════════

-- ── Papers (from PubMed) ──
CREATE TABLE papers (
  id BIGSERIAL PRIMARY KEY,
  pmid TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  abstract TEXT DEFAULT '',
  authors JSONB DEFAULT '[]',
  journal TEXT DEFAULT '',
  pub_date DATE,
  mesh_terms JSONB DEFAULT '[]',
  keywords JSONB DEFAULT '[]',
  doi TEXT DEFAULT '',
  paper_type TEXT DEFAULT 'article',
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  search_vector TSVECTOR
);

CREATE INDEX idx_papers_pmid ON papers(pmid);
CREATE INDEX idx_papers_search ON papers USING GIN(search_vector);
CREATE INDEX idx_papers_fetched ON papers(fetched_at DESC);
CREATE INDEX idx_papers_pubdate ON papers(pub_date DESC);

-- Auto-update search_vector on insert/update
CREATE OR REPLACE FUNCTION papers_search_update() RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.abstract, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_papers_search
  BEFORE INSERT OR UPDATE ON papers
  FOR EACH ROW EXECUTE FUNCTION papers_search_update();


-- ── Profiles (linked to Supabase Auth) ──
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  institution TEXT DEFAULT '',
  keywords TEXT[] DEFAULT '{}',
  mesh_terms TEXT[] DEFAULT '{}',
  preferred_journals TEXT[] DEFAULT '{}',
  email_digest BOOLEAN DEFAULT TRUE,
  digest_frequency TEXT DEFAULT 'daily' CHECK (digest_frequency IN ('daily','weekly')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'name', ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ── Feedbacks ──
CREATE TABLE feedbacks (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  paper_id BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('like','dislike','save')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, paper_id)
);

CREATE INDEX idx_feedbacks_user ON feedbacks(user_id, action);
CREATE INDEX idx_feedbacks_paper ON feedbacks(paper_id);


-- ── Read History ──
CREATE TABLE read_history (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  paper_id BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  dwell_seconds INT DEFAULT 0,
  scroll_depth REAL DEFAULT 0,
  source TEXT DEFAULT 'recommendation',
  clicked_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_read_user ON read_history(user_id, clicked_at DESC);
CREATE INDEX idx_read_paper ON read_history(paper_id);


-- ── Daily Recommendations (cache) ──
CREATE TABLE recommendations (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  paper_id BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  reasons JSONB DEFAULT '{}',
  rec_date DATE NOT NULL,
  is_read BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_rec_user_date ON recommendations(user_id, rec_date DESC);


-- ── Collections ──
CREATE TABLE collections (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  color TEXT DEFAULT '#007AFF',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE collection_papers (
  collection_id BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  paper_id BIGINT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(collection_id, paper_id)
);


-- ── Alerts ──
CREATE TABLE alerts (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('keyword','author','journal')),
  value TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  last_triggered TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════
--  Row Level Security
-- ═══════════════════════════════════════════════════

-- Papers: anyone reads, service_role inserts
ALTER TABLE papers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "papers_select" ON papers FOR SELECT USING (true);
CREATE POLICY "papers_insert" ON papers FOR INSERT WITH CHECK (
  (SELECT current_setting('request.jwt.claims', true)::json->>'role') = 'service_role'
);

-- Profiles: own data only
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- Feedbacks: own data
ALTER TABLE feedbacks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "feedbacks_all" ON feedbacks FOR ALL USING (auth.uid() = user_id);

-- Read history: own data
ALTER TABLE read_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read_history_all" ON read_history FOR ALL USING (auth.uid() = user_id);

-- Recommendations: own data
ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "recommendations_select" ON recommendations FOR SELECT USING (auth.uid() = user_id);

-- Collections: own data
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "collections_all" ON collections FOR ALL USING (auth.uid() = user_id);

ALTER TABLE collection_papers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "collection_papers_all" ON collection_papers FOR ALL USING (
  EXISTS (SELECT 1 FROM collections WHERE id = collection_id AND user_id = auth.uid())
);

-- Alerts: own data
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "alerts_all" ON alerts FOR ALL USING (auth.uid() = user_id);


-- ═══════════════════════════════════════════════════
--  Upsert helper for feedbacks
-- ═══════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION upsert_feedback(
  p_user_id UUID, p_paper_id BIGINT, p_action TEXT
) RETURNS void AS $$
BEGIN
  INSERT INTO feedbacks (user_id, paper_id, action)
  VALUES (p_user_id, p_paper_id, p_action)
  ON CONFLICT (user_id, paper_id)
  DO UPDATE SET action = p_action, created_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
