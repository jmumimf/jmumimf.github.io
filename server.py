"""Estimathon event server: static pages + a SQLite-backed API.

    py -3 server.py                 # http://localhost:8000
    py -3 server.py --port 9000 --db saturday.db

Everything lives in one SQLite file (estimathon.db by default), so submissions
survive a crash, a laptop reboot, or an accidental browser close -- and you can
open it with any SQLite tool mid-event and run a query. score.py reads the same
file directly.

The pages themselves are the plain static files in this folder. When this
server hands out an .html file it injects one line

    <script>window.ESTIMATHON_API = "/api";</script>

which flips the client from browser-local storage to this API. That means the
same files work unchanged on GitHub Pages (no server -> local storage) and
here (server -> shared storage), with nothing to configure either way.

Stdlib only. No pip install.
"""

import argparse
import json
import mimetypes
import re
import sqlite3
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from questions import load_questions

HERE = Path(__file__).resolve().parent
MAX_BODY = 64 * 1024

SCHEMA = """
CREATE TABLE IF NOT EXISTS questions (
    id       TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    text     TEXT NOT NULL,
    unit     TEXT NOT NULL DEFAULT '',
    answer   REAL
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
"""

CONFIG_DEFAULTS = {
    "eventName": "JMU MIMF Estimathon",
    "maxSubmissions": 18,
    "contestOpen": False,
    "showLeaderboardToTeams": False,
    "answersReleased": False,
}

INJECT = '<script>window.ESTIMATHON_API = "/api";</script>\n'


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

class Database:
    """All state, guarded by one lock. The event is a handful of writes a
    minute, so a single connection is plenty and keeps the logic obvious."""

    def __init__(self, path, reseed=False):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.con = sqlite3.connect(str(self.path), check_same_thread=False)
        self.con.row_factory = sqlite3.Row
        self.con.execute("PRAGMA foreign_keys = ON")
        self.con.execute("PRAGMA journal_mode = WAL")
        self.con.executescript(SCHEMA)
        self.con.commit()
        self._seed_config()
        self.sync_questions(reseed=reseed)

    def _seed_config(self):
        with self.lock:
            for key, value in CONFIG_DEFAULTS.items():
                self.con.execute(
                    "INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)",
                    (key, json.dumps(value)))
            self.con.commit()

    def sync_questions(self, reseed=False):
        """Pull the question list from estimathon.js.

        New questions are inserted; existing ones have their text, unit and
        order refreshed. Answers already in the database are left alone unless
        --reseed, so an answer corrected from the admin page during the event
        is not clobbered by a restart.
        """
        questions = load_questions()
        with self.lock:
            existing = {r["id"] for r in self.con.execute("SELECT id FROM questions")}
            for i, q in enumerate(questions):
                if q["id"] in existing and not reseed:
                    self.con.execute(
                        "UPDATE questions SET position = ?, text = ?, unit = ? WHERE id = ?",
                        (i, q["text"], q["unit"], q["id"]))
                else:
                    self.con.execute(
                        "INSERT INTO questions (id, position, text, unit, answer) "
                        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                        "position = excluded.position, text = excluded.text, "
                        "unit = excluded.unit, answer = excluded.answer",
                        (q["id"], i, q["text"], q["unit"], q["answer"]))
            live = {q["id"] for q in questions}
            for gone in existing - live:
                self.con.execute("DELETE FROM questions WHERE id = ?", (gone,))
            self.con.commit()
        return questions

    # ----- reads -----------------------------------------------------------

    def state(self, include_answers=True):
        """The whole event, in the shape the client expects.

        With include_answers=False the answer key is stripped out before the
        response leaves the building. That is the point of running this server
        rather than the static build: a team that opens devtools sees no
        answers, because their browser was never sent any.
        """
        with self.lock:
            config = {r["key"]: json.loads(r["value"])
                      for r in self.con.execute("SELECT * FROM config")}
            reveal = include_answers or config.get("answersReleased", False)
            config["questions"] = [
                {"id": r["id"], "text": r["text"], "unit": r["unit"],
                 "answer": r["answer"] if reveal else None}
                for r in self.con.execute("SELECT * FROM questions ORDER BY position")
            ]
            teams = [
                {"id": r["id"], "name": r["name"], "members": r["members"],
                 "joinedAt": r["joined_at"]}
                for r in self.con.execute("SELECT * FROM teams ORDER BY joined_at")
            ]
            submissions = [
                {"id": r["id"], "teamId": r["team_id"], "questionId": r["question_id"],
                 "low": r["low"], "high": r["high"], "at": r["at"]}
                for r in self.con.execute("SELECT * FROM submissions ORDER BY at")
            ]
        return {"config": config, "teams": teams, "submissions": submissions}

    def _config_value(self, key):
        row = self.con.execute("SELECT value FROM config WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else CONFIG_DEFAULTS.get(key)

    # ----- writes ----------------------------------------------------------

    def join(self, name, members):
        name = (name or "").strip()
        if not name:
            raise ApiError("Team name is required.")
        if len(name) > 60:
            raise ApiError("That team name is too long.")

        with self.lock:
            row = self.con.execute("SELECT * FROM teams WHERE name = ?", (name,)).fetchone()
            if row:
                # Same name = same team. This is how a team gets back in after
                # a refresh, or adds a second device.
                return {"team": {"id": row["id"], "name": row["name"],
                                 "members": row["members"], "joinedAt": row["joined_at"]},
                        "rejoined": True}
            team = {"id": "team_" + uuid.uuid4().hex[:8], "name": name,
                    "members": (members or "").strip()[:200], "joinedAt": int(time.time() * 1000)}
            self.con.execute(
                "INSERT INTO teams (id, name, members, joined_at) VALUES (?, ?, ?, ?)",
                (team["id"], team["name"], team["members"], team["joinedAt"]))
            self.con.commit()
        return {"team": team, "rejoined": False}

    def submit(self, team_id, question_id, low, high):
        """The client validates too, but the server is the one that decides:
        a closed contest and the submission cap are enforced here."""
        try:
            low, high = float(low), float(high)
        except (TypeError, ValueError):
            raise ApiError("Both bounds must be numbers.")
        if not (low > 0 and high > 0):
            raise ApiError("Both bounds must be greater than zero.")
        if high < low:
            raise ApiError("The high bound must be at least the low bound.")

        with self.lock:
            if not self._config_value("contestOpen"):
                raise ApiError("Submissions are closed.")
            if not self.con.execute("SELECT 1 FROM teams WHERE id = ?", (team_id,)).fetchone():
                raise ApiError("That team is no longer signed in. Rejoin to keep going.", 404)
            if not self.con.execute("SELECT 1 FROM questions WHERE id = ?",
                                    (question_id,)).fetchone():
                raise ApiError("Unknown question %r." % question_id)

            used = self.con.execute(
                "SELECT COUNT(*) AS n FROM submissions WHERE team_id = ?",
                (team_id,)).fetchone()["n"]
            cap = self._config_value("maxSubmissions")
            if used >= cap:
                raise ApiError("Your team has used all %d submissions." % cap)

            entry = {"id": "sub_" + uuid.uuid4().hex[:8], "teamId": team_id,
                     "questionId": question_id, "low": low, "high": high,
                     "at": int(time.time() * 1000)}
            self.con.execute(
                "INSERT INTO submissions (id, team_id, question_id, low, high, at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (entry["id"], team_id, question_id, low, high, entry["at"]))
            self.con.commit()
        return entry

    def patch_config(self, patch):
        with self.lock:
            for key, value in patch.items():
                if key == "answer":
                    qid, val = value.get("questionId"), value.get("value")
                    self.con.execute("UPDATE questions SET answer = ? WHERE id = ?",
                                     (None if val is None else float(val), qid))
                elif key in CONFIG_DEFAULTS:
                    self.con.execute(
                        "INSERT INTO config (key, value) VALUES (?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (key, json.dumps(value)))
                elif key != "questions":
                    raise ApiError("Unknown config key %r." % key)
            self.con.commit()
        return {"ok": True}

    def delete_team(self, team_id):
        with self.lock:
            self.con.execute("DELETE FROM submissions WHERE team_id = ?", (team_id,))
            self.con.execute("DELETE FROM teams WHERE id = ?", (team_id,))
            self.con.commit()
        return {"ok": True}

    def reset(self):
        """Clear teams and submissions. Questions and answers stay."""
        with self.lock:
            self.con.execute("DELETE FROM submissions")
            self.con.execute("DELETE FROM teams")
            for key, value in CONFIG_DEFAULTS.items():
                if key in ("contestOpen", "showLeaderboardToTeams"):
                    self.con.execute("UPDATE config SET value = ? WHERE key = ?",
                                     (json.dumps(value), key))
            self.con.commit()
        return {"ok": True}


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def read_admin_code():
    """The organizer passcode, taken from admin.js so there is one place to
    change it. Used here to decide who may see the answer key."""
    m = re.search(r"var PASSCODE\s*=\s*'([^']*)'", (HERE / "admin.js").read_text(encoding="utf-8"))
    return m.group(1) if m else "mimf"


class Handler(BaseHTTPRequestHandler):
    server_version = "Estimathon/1.0"
    db = None
    root = HERE
    admin_code = "mimf"

    # ----- plumbing --------------------------------------------------------

    def log_message(self, fmt, *args):
        # One tidy line per request; the default is noisy during an event.
        if self.path.startswith("/api/state"):
            return
        print("  %s  %s" % (self.command, self.path))

    def _send(self, status, body, content_type, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, payload, status=200):
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json")

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ApiError("Request body is too large.", 413)
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError("Body was not valid JSON.")

    # ----- routes ----------------------------------------------------------

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self._api_get(path)
        return self._static(path)

    do_HEAD = do_GET

    def do_POST(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return self._send(405, b"Not allowed", "text/plain")
        try:
            body = self._read_json()
            if path == "/api/join":
                return self._json(self.db.join(body.get("name"), body.get("members")))
            if path == "/api/submit":
                return self._json(self.db.submit(
                    body.get("teamId"), body.get("questionId"),
                    body.get("low"), body.get("high")))
            if path == "/api/config":
                return self._json(self.db.patch_config(body))
            if path == "/api/team/delete":
                return self._json(self.db.delete_team(body.get("teamId")))
            if path == "/api/reset":
                return self._json(self.db.reset())
            return self._json({"error": "No such endpoint."}, 404)
        except ApiError as err:
            return self._json({"error": str(err)}, err.status)
        except sqlite3.Error as err:
            self.log_message("db error: %s", err)
            return self._json({"error": "Database error: %s" % err}, 500)

    def _api_get(self, path):
        if path == "/api/state":
            # The admin page sends ?key=<admin code>; everyone else gets the
            # answer key blanked until it is released.
            key = parse_qs(urlparse(self.path).query).get("key", [""])[0]
            return self._json(self.db.state(include_answers=(key == self.admin_code)))
        if path == "/api/admin-check":
            key = parse_qs(urlparse(self.path).query).get("key", [""])[0]
            return self._json({"ok": key == self.admin_code})
        if path == "/api/health":
            return self._json({"ok": True, "db": str(self.db.path)})
        return self._json({"error": "No such endpoint."}, 404)

    # ----- static files ----------------------------------------------------

    def _static(self, path):
        if path.endswith("/"):
            path += "index.html"
        target = (self.root / path.lstrip("/")).resolve()

        # Never serve outside the project folder, and never serve the database
        # or the Python source.
        if not str(target).startswith(str(self.root)) or not target.is_file():
            return self._send(404, b"Not found", "text/plain; charset=utf-8")
        if target.suffix in (".py", ".db") or target.name.startswith("estimathon.db"):
            return self._send(403, b"Forbidden", "text/plain; charset=utf-8")

        if target.suffix == ".html":
            html = target.read_text(encoding="utf-8")
            body = self._inject(html).encode("utf-8")
            return self._send(200, body, "text/html; charset=utf-8")

        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype == "application/javascript":
            ctype += "; charset=utf-8"
        return self._send(200, target.read_bytes(), ctype)

    @staticmethod
    def _inject(html):
        """Point the page at this server, ahead of estimathon.js.

        Both HTML files carry a commented-out ESTIMATHON_API example, so the
        "did someone already configure this by hand?" check has to ignore
        anything inside an HTML comment.
        """
        live = re.sub(r"<!--.*?-->", "", html, flags=re.S)
        if "ESTIMATHON_API" in live:
            return html  # configured by hand; leave it alone
        return re.sub(r'([ \t]*)(<script src="estimathon\.js"></script>)',
                      lambda m: m.group(1) + INJECT.rstrip() + "\n" + m.group(1) + m.group(2),
                      html, count=1)


def main():
    p = argparse.ArgumentParser(description="Run the Estimathon event server.")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--host", default="0.0.0.0",
                   help="0.0.0.0 (default) lets other devices on the network connect")
    p.add_argument("--db", default=str(HERE / "estimathon.db"))
    p.add_argument("--reseed", action="store_true",
                   help="overwrite stored answers with the ones in estimathon.js")
    p.add_argument("--admin-code", default=None,
                   help="organizer passcode (default: the PASSCODE in admin.js)")
    args = p.parse_args()

    Handler.db = Database(args.db, reseed=args.reseed)
    Handler.root = HERE
    Handler.admin_code = args.admin_code or read_admin_code()

    state = Handler.db.state()
    print("Estimathon server")
    print("  database   %s" % args.db)
    print("  questions  %d (%d keyed)" % (
        len(state["config"]["questions"]),
        sum(1 for q in state["config"]["questions"] if q["answer"] is not None)))
    print("  teams      %d, %d submissions" % (len(state["teams"]), len(state["submissions"])))
    print("  team page  http://localhost:%d/" % args.port)
    print("  admin      http://localhost:%d/admin.html" % args.port)
    if args.host == "0.0.0.0":
        print("  (share your machine's LAN address for phones on the same wifi)")
    print("  Ctrl+C to stop\n")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
