-- yt-factory-cm-1 · migration 002: agent jobs can hand off to Script by themselves
-- when the brief passes the checks (angle, >=5 facts, >=3 competitors).
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS auto_handoff boolean NOT NULL DEFAULT true;
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS handed_off_at timestamptz;
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS handed_off_by_user_id varchar REFERENCES users(id);
