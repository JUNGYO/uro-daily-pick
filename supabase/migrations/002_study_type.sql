-- Add study_type classification to papers
ALTER TABLE papers ADD COLUMN IF NOT EXISTS study_type TEXT DEFAULT 'other';
ALTER TABLE papers ADD COLUMN IF NOT EXISTS pub_types JSONB DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_papers_study_type ON papers(study_type);

-- Add study_type preferences to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS preferred_study_types TEXT[] DEFAULT '{}';

-- Add onboarding_done flag
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS onboarding_done BOOLEAN DEFAULT FALSE;
