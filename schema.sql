CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Notes written in the app (drafts, queue, published history)
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | scheduled | publishing | published | failed
  scheduled_at INTEGER,                 -- epoch ms
  published_at INTEGER,
  substack_id TEXT,
  error TEXT,
  source TEXT,                          -- manual | generated
  created_at INTEGER NOT NULL,
  ai_original TEXT,                     -- text as Claude proposed it, if it was a suggestion
  reviewed INTEGER NOT NULL DEFAULT 1,  -- 0 until a suggestion has been rewritten by the writer
  native_id TEXT                        -- id of the scheduled draft in Substack, when Substack's own scheduler publishes it
);
CREATE INDEX IF NOT EXISTS notes_due ON notes (status, scheduled_at);

-- Every note found on the Substack profile, with its public metrics
CREATE TABLE IF NOT EXISTS my_notes (
  substack_id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  date INTEGER NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  restacks INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL,
  follows INTEGER, free_subs INTEGER, paid_subs INTEGER, clicks INTEGER, share_clicks INTEGER, arr REAL, -- what the note brought in
  stats_at INTEGER
);

CREATE TABLE IF NOT EXISTS follows (
  handle TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT,
  photo_url TEXT,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_items (
  substack_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  body TEXT NOT NULL,
  date INTEGER NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  restacks INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS feed_date ON feed_items (date);

-- Replies to my notes that I have not answered yet
CREATE TABLE IF NOT EXISTS activity (
  reply_id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  note_body TEXT,
  author_name TEXT,
  author_handle TEXT,
  body TEXT NOT NULL,
  date INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',  -- open | done
  author_id INTEGER
);

-- Notes by other writers saved as a starting point for my own
CREATE TABLE IF NOT EXISTS inspirations (
  substack_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  name TEXT,
  body TEXT NOT NULL,
  saved_at INTEGER NOT NULL
);

-- People who interact with me or that I looked up, with audience size and public subscriptions
CREATE TABLE IF NOT EXISTS people (
  user_id INTEGER PRIMARY KEY,
  handle TEXT,
  name TEXT,
  photo_url TEXT,
  bio TEXT,
  followers INTEGER,
  subscribers TEXT,
  publication TEXT,
  pub_subdomain TEXT,
  subscriptions TEXT,            -- JSON: [{name, subdomain, state, founding}]
  subs_truncated INTEGER DEFAULT 0,
  tag TEXT,                      -- lettore | creator | imprenditore | competitor | coopetitor
  refreshed_at INTEGER,
  added_at INTEGER NOT NULL,
  circle INTEGER NOT NULL DEFAULT 0,     -- 1 = I chose to follow this person closely
  dismissed INTEGER NOT NULL DEFAULT 0,  -- 1 = do not suggest again
  sub_manual TEXT,                       -- paid | free | none, set by hand when the public profile does not tell
  note TEXT,
  next_step TEXT,
  next_date INTEGER,
  kind TEXT,                             -- iscritto | creator (which side of People)
  posts TEXT,                            -- JSON: recent posts of a watched creator
  topics TEXT                            -- JSON: Claude's reading of what a creator writes about
);

-- What I wrote to someone (by hand, outside the app) and how it went
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date INTEGER NOT NULL,
  kind TEXT,
  text TEXT,
  outcome TEXT
);

-- One row per day with my own numbers
CREATE TABLE IF NOT EXISTS snapshots (
  day TEXT PRIMARY KEY,
  followers INTEGER,
  subscribers TEXT,
  notes INTEGER,
  likes INTEGER,
  restacks INTEGER,
  replies INTEGER
);

-- Research documents written elsewhere, kept here to be read while working
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL
);

-- Follower count of each watched creator, one row per day
CREATE TABLE IF NOT EXISTS creator_snapshots (
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  followers INTEGER,
  PRIMARY KEY (user_id, day)
);

-- Problems the writer must know about (failed publication, broken connection, due follow-ups)
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  ref TEXT UNIQUE,
  seen INTEGER NOT NULL DEFAULT 0
);
