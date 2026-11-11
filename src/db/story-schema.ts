/** page.selected_text_id intentionally has no FK constraint: it points at a row in `text`. */
export const STORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS book (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  parent_book_id TEXT REFERENCES book(id),
  book_type TEXT NOT NULL CHECK (book_type IN ('user','story','worldbook','logbook')),
  hidden INTEGER NOT NULL DEFAULT 0,
  broken INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS page (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  book_id TEXT NOT NULL REFERENCES book(id),
  prev_page_id TEXT REFERENCES page(id),
  selected_fork_page_id TEXT REFERENCES page(id),
  selected_text_id TEXT,
  select_time TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  broken INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_page_book ON page(book_id);
CREATE INDEX IF NOT EXISTS idx_page_prev ON page(prev_page_id);
CREATE INDEX IF NOT EXISTS idx_page_selected_text ON page(selected_text_id);

CREATE TABLE IF NOT EXISTS text (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES page(id),
  prior_text_id TEXT REFERENCES text(id),
  role TEXT NOT NULL CHECK (role IN ('user','agent','system')),
  source_page_id TEXT REFERENCES page(id),
  hidden INTEGER NOT NULL DEFAULT 0,
  broken INTEGER NOT NULL DEFAULT 0,
  gen_request TEXT,
  gen_package TEXT,
  gen_metrics TEXT
);
CREATE INDEX IF NOT EXISTS idx_text_page ON text(page_id);
CREATE INDEX IF NOT EXISTS idx_text_prior ON text(prior_text_id);


CREATE TABLE IF NOT EXISTS story_to_date_segment (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  book_id TEXT NOT NULL REFERENCES book(id),
  kind TEXT NOT NULL CHECK (kind IN ('begins','continues','fold')),
  content TEXT,
  coverage_through_ic_post INTEGER,
  coverage_page_id TEXT REFERENCES page(id),
  input_ceiling_ic_post INTEGER,
  input_ceiling_page_id TEXT REFERENCES page(id),
  seq INTEGER NOT NULL,
  name TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  broken INTEGER NOT NULL DEFAULT 0,
  audit_verdict TEXT,
  audit_missing TEXT,
  audit_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_story_to_date_book ON story_to_date_segment(book_id);

-- One row per worldbook entry, keyed to its page.
CREATE TABLE IF NOT EXISTS worldbook_entry (
  page_id TEXT PRIMARY KEY REFERENCES page(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('content','roster','memory'))
);

-- Single-row table (id=1 enforced) tracking where this story is in the Setup -> Kickoff -> Story flow.
CREATE TABLE IF NOT EXISTS story_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL DEFAULT 'setup' CHECK (phase IN ('setup','kickoff','active')),
  kickoff_page_id TEXT REFERENCES page(id),
  current_page_id TEXT REFERENCES page(id),
  history_cursor_seq INTEGER NOT NULL DEFAULT 0,
  ooc_session_start_page_id TEXT REFERENCES page(id)
);
INSERT OR IGNORE INTO story_state (id, phase, kickoff_page_id) VALUES (1, 'setup', NULL);

-- The Play tab's undo/redo stack: one flat, ordered list of page and text selections.
CREATE TABLE IF NOT EXISTS history_event (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('page','text')),
  page_id TEXT NOT NULL REFERENCES page(id),
  from_value TEXT,
  to_value TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_event_seq ON history_event(seq);

-- A job targets exactly one of target_text_id or target_story_to_date_id.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  target_text_id TEXT REFERENCES text(id),
  target_story_to_date_id TEXT REFERENCES story_to_date_segment(id),
  job_type TEXT NOT NULL CHECK (job_type IN ('prose','setup','setup-worldbook','story-name','segment-name','story-to-date','story-to-date-fold','worldbook-compact','segment-audit')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  slot_cost INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  token_estimate INTEGER,
  input_token_estimate INTEGER,
  horde_request_id TEXT,
  elapsed_ms INTEGER,
  result_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_target_text ON jobs(target_text_id);
CREATE INDEX IF NOT EXISTS idx_jobs_target_story_to_date ON jobs(target_story_to_date_id);
`
