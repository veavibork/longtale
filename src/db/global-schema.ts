export const GLOBAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_kdf_salt TEXT NOT NULL,
  password_verifier TEXT NOT NULL,
  encrypted_settings TEXT,
  featherless_key_encrypted TEXT,
  horde_key_encrypted TEXT,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_display_name ON users(lower(display_name));

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS layout_configs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_layout_configs_user ON layout_configs(user_id);

-- Generic key-value JSON storage for Settings-tab spaces (Global CSS, Play tab display, banned phrases)
CREATE TABLE IF NOT EXISTS settings_spaces (
  space TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  json_blob TEXT NOT NULL,
  previous_json_blob TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (space, user_id)
);

CREATE TABLE IF NOT EXISTS preference_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  encrypted_settings_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preference_profiles_user ON preference_profiles(user_id);

-- One row per configured model; the use_* flags assign it to roles and sort_order ranks fallbacks.
CREATE TABLE IF NOT EXISTS model_configs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL DEFAULT 'featherless',
  model TEXT NOT NULL,
  temperature REAL NOT NULL DEFAULT 1.0,
  response_limit INTEGER NOT NULL DEFAULT 4096,
  context_limit INTEGER NOT NULL DEFAULT 32000,
  presence_penalty REAL,
  frequency_penalty REAL,
  repetition_penalty REAL,
  top_p REAL,
  top_k INTEGER,
  min_p REAL,
  concurrency_cost INTEGER,
  use_author INTEGER NOT NULL DEFAULT 0,
  use_editor INTEGER NOT NULL DEFAULT 0,
  use_worker INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_configs_user ON model_configs(user_id);

-- One row per (provider, model) = the model's probed format profile AND its probe-queue entry.
CREATE TABLE IF NOT EXISTS model_format_profiles (
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  profile_json TEXT,
  probed_at TEXT,
  artifact_dir TEXT,
  error TEXT,
  -- Runtime tripwire (plan step 6): set when a live stream contradicted the stored profile.
  drift_detected_at TEXT,
  drift_reasons TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model_id)
);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  parent_story_id TEXT REFERENCES stories(id),
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_owner ON stories(owner_user_id);

-- Frontend error log fed by web/src/lib/toast.ts whenever a warning/error/critical toast fires.
CREATE TABLE IF NOT EXISTS client_errors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  url TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_errors_user_created ON client_errors(user_id, created_at);
`
