-- Structured data extraction, clinical relevance, and Q&A from Gemini
ALTER TABLE papers ADD COLUMN IF NOT EXISTS structured_data JSONB DEFAULT '{}';
ALTER TABLE papers ADD COLUMN IF NOT EXISTS clinical_relevance INTEGER DEFAULT 0;
ALTER TABLE papers ADD COLUMN IF NOT EXISTS qa_data JSONB DEFAULT '[]';
