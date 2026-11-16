-- yt-factory-cm-1 · migration 001: research stage, role tokens, agent runs
-- Additive only: no existing table, column or row is dropped or rewritten.
BEGIN;

-- 1. Pipeline roles (the 4-role model in workers/_index.md). Legacy CM roles stay.
INSERT INTO roles (id, code, label) VALUES
  ('role-research',   'research',   'Research'),
  ('role-content',    'content',    'Content'),
  ('role-production', 'production', 'Production'),
  ('role-publish',    'publish',    'Publish')
ON CONFLICT (code) DO NOTHING;

-- 2. Humans vs agents share one users table.
ALTER TABLE users ADD COLUMN IF NOT EXISTS kind varchar NOT NULL DEFAULT 'human';
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_kind_chk CHECK (kind IN ('human','agent'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Access tokens: one token = one user + one role. Only a hash is stored.
CREATE TABLE IF NOT EXISTS access_tokens (
  id                 varchar PRIMARY KEY,
  user_id            varchar NOT NULL REFERENCES users(id),
  role_id            varchar NOT NULL REFERENCES roles(id),
  label              varchar NOT NULL DEFAULT '',
  token_prefix       varchar NOT NULL,            -- first 10 chars, for display
  token_hash         varchar NOT NULL UNIQUE,     -- sha256 hex of the full token
  created_by_user_id varchar REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  expires_at         timestamptz,
  revoked_at         timestamptz
);
CREATE INDEX IF NOT EXISTS access_tokens_user_idx ON access_tokens(user_id);

-- 4. Research jobs: the Idea stage of a video ticket.
CREATE TABLE IF NOT EXISTS research_jobs (
  id                   varchar PRIMARY KEY,
  video_id             varchar NOT NULL REFERENCES video_tickets(id),
  channel_id           varchar NOT NULL REFERENCES channels(id),
  mode                 varchar NOT NULL DEFAULT 'topic',     -- topic | viral_breakdown
  seed_topic           text,
  seed_video_url       text,
  notes                text,
  status               varchar NOT NULL DEFAULT 'queued',
  assignee_kind        varchar NOT NULL DEFAULT 'agent',     -- agent | human
  assigned_user_id     varchar REFERENCES users(id),
  requested_by_user_id varchar REFERENCES users(id),
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  finished_at          timestamptz,
  CONSTRAINT research_jobs_mode_chk CHECK (mode IN ('topic','viral_breakdown')),
  CONSTRAINT research_jobs_status_chk CHECK (status IN ('queued','running','review','handed_off','failed','cancelled')),
  CONSTRAINT research_jobs_assignee_chk CHECK (assignee_kind IN ('agent','human'))
);
CREATE INDEX IF NOT EXISTS research_jobs_status_idx ON research_jobs(status, created_at);

-- 5. Research brief (versioned; latest version is the live one). Mirrors sops/00-research-brief.md.
CREATE TABLE IF NOT EXISTS research_briefs (
  id               varchar PRIMARY KEY,
  job_id           varchar NOT NULL REFERENCES research_jobs(id),
  video_id         varchar NOT NULL REFERENCES video_tickets(id),
  version          integer NOT NULL DEFAULT 1,
  angle            text,
  why_now          text,
  audience         text,
  whats_new        text,
  viral_breakdown  jsonb,   -- {hook, promise, structure[], pacing, why_it_works, misses}
  remix_extra      text,    -- the one extra that is ours
  title_ideas      jsonb,   -- string[]
  asset_notes      jsonb,   -- [{need, source, license, rights_risk}]
  rights_flags     jsonb,   -- string[]
  author_kind      varchar NOT NULL DEFAULT 'agent',
  author_user_id   varchar REFERENCES users(id),
  r2_key           text,    -- markdown export in R2
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, version)
);

-- 6. Facts with sources (step 6 of the SOP).
CREATE TABLE IF NOT EXISTS research_facts (
  id           varchar PRIMARY KEY,
  brief_id     varchar NOT NULL REFERENCES research_briefs(id) ON DELETE CASCADE,
  position     integer NOT NULL DEFAULT 0,
  claim        text NOT NULL,
  source_url   text,
  source_title text,
  verified     boolean NOT NULL DEFAULT false      -- false = UNVERIFIED
);

-- 7. Seed + competitor videos (steps 3 and 5). Views only when actually seen.
CREATE TABLE IF NOT EXISTS reference_videos (
  id               varchar PRIMARY KEY,
  brief_id         varchar NOT NULL REFERENCES research_briefs(id) ON DELETE CASCADE,
  kind             varchar NOT NULL DEFAULT 'competitor',  -- seed | competitor
  youtube_id       varchar,
  url              text NOT NULL,
  title            text,
  channel_name     text,
  views_seen       bigint,
  views_seen_at    timestamptz,
  duration_s       integer,
  notes            text,                                    -- what it misses / why it works
  thumbnail_r2_key text,
  CONSTRAINT reference_videos_kind_chk CHECK (kind IN ('seed','competitor'))
);

-- 8. Agent runs: model, tokens, cost, log in R2.
CREATE TABLE IF NOT EXISTS agent_runs (
  id            varchar PRIMARY KEY,
  job_id        varchar NOT NULL REFERENCES research_jobs(id),
  agent_user_id varchar REFERENCES users(id),
  runtime       varchar NOT NULL DEFAULT 'pi',
  model         varchar NOT NULL,
  status        varchar NOT NULL DEFAULT 'running',  -- running | succeeded | failed
  input_tokens  integer,
  output_tokens integer,
  cost_usd      numeric(10,5),
  tool_calls    integer,
  log_r2_key    text,
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

-- 9. The research agent as a user with the research role.
INSERT INTO users (id, username, display_name, password_hash, cred_status, created_at, updated_at, kind)
VALUES ('usr_agent_research', 'agent.research', 'Research agent (pi)', '!agent-no-password', 'issued', now(), now(), 'agent')
ON CONFLICT (username) DO NOTHING;
INSERT INTO user_roles (user_id, role_id)
SELECT 'usr_agent_research', 'role-research'
WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id='usr_agent_research' AND role_id='role-research');

COMMIT;
