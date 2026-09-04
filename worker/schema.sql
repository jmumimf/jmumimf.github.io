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

-- ---------------------------------------------------------------------------
-- Forms. Separate from the Estimathon; same database and same admin passcode.
-- ---------------------------------------------------------------------------

-- `fields` is the JSON array of question definitions, exactly as authored in
-- forms.json. Keeping it as one blob means adding a new question type never
-- needs a migration.
CREATE TABLE IF NOT EXISTS forms (
    id           TEXT PRIMARY KEY,
    position     INTEGER NOT NULL DEFAULT 0,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'closed'
    submit_label TEXT NOT NULL DEFAULT 'Submit',
    confirmation TEXT NOT NULL DEFAULT '',
    fields       TEXT NOT NULL DEFAULT '[]'
);

-- One row per submitted form. `answers` is {fieldId: value}, where value is a
-- string or an array of strings.
CREATE TABLE IF NOT EXISTS form_responses (
    id           TEXT PRIMARY KEY,
    form_id      TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    submitted_at INTEGER NOT NULL,
    answers      TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_resp_form ON form_responses(form_id, submitted_at);

INSERT OR IGNORE INTO config (key, value) VALUES
    ('eventName',              '"JMU MIMF Estimathon"'),
    ('maxSubmissions',         '18'),
    ('contestOpen',            'false'),
    ('showLeaderboardToTeams', 'false'),
    ('answersReleased',        'false');
