-- D1 schema for the Estimathon API. D1 is SQLite, so this is the same schema
-- server.py builds locally.
--
--   wrangler d1 execute estimathon --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS questions (
    id       TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    text     TEXT NOT NULL,
    unit     TEXT NOT NULL DEFAULT '',
    answer   REAL,
    -- 'pending' = teams have not seen it, 'open' = accepting submissions,
    -- 'closed' = shown but locked.
    status   TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS teams (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL COLLATE NOCASE UNIQUE,
    members   TEXT NOT NULL DEFAULT '',
    joined_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
    id          TEXT PRIMARY KEY,
    team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    low         REAL NOT NULL,
    high        REAL NOT NULL,
    at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_team ON submissions(team_id, question_id, at);

CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO config (key, value) VALUES
    ('eventName',              '"JMU MIMF Estimathon"'),
    ('maxSubmissions',         '18'),
    ('contestOpen',            'false'),
    ('showLeaderboardToTeams', 'false'),
    ('answersReleased',        'false');
