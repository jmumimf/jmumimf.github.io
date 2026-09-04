"""Estimathon scoring.

Per-question score for an interval [a, b] against the true answer n:

    e_i(a, b, n) = 0                       if a <= n <= b
                 = log2(max(a/n, n/b))     otherwise   (how far off, in octaves)

    score_i(a, b, n) = WIDTH_WEIGHT * (b / a) + e_i(a, b, n)

A team's final score is the sum of score_i over every question. Lower wins.
A perfect run — every answer bracketed with a = b — scores WIDTH_WEIGHT per
question.

The same formula is implemented in `Scoring.scoreTeam` in estimathon.js so the
live scoreboard matches this file. `python -m score --selftest` checks that the
two copies of the constants below still agree.
"""

import argparse
import csv
import json
import math
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent          # the repo root, which is what GitHub Pages serves

# --- tunables ---------------------------------------------------------------
# Cost per unit of interval width. score_i for a bracketed answer of ratio r is
# WIDTH_WEIGHT * r, so a 10x-wide interval costs 0.7 and a 100x-wide one costs 7.
WIDTH_WEIGHT = 0.07

# What an unanswered question costs. Your formula only defines a score for an
# interval that exists, so this is the one number the rules had to add. At 10.0
# a team is always better off guessing: a wildly wrong but sane-width interval
# (say 5x wide and off by 2^6) still scores 0.35 + 6 = 6.35 < 10.
UNANSWERED_PENALTY = 10.0
# ----------------------------------------------------------------------------

def e_i(a, b, n):
    """Miss penalty in octaves: 0 if the interval brackets n, else log2 of the
    factor by which it misses."""
    if a <= n <= b:
        return 0.0
    if n == 0 or a == 0 or b == 0:
        raise ValueError("score is undefined for a zero bound or answer")
    off = max(abs(a / n), abs(n / b))
    return math.log2(abs(off))

def score_i(a, b, n):
    """Score one interval. Lower is better."""
    if a <= 0 or b <= 0:
        raise ValueError("bounds must be positive, got [%r, %r]" % (a, b))
    if b < a:
        raise ValueError("high bound %r is below low bound %r" % (b, a))
    return WIDTH_WEIGHT * abs(b / a) + e_i(a, b, n)

def score_question(interval, answer):
    """score_i, but tolerant of the two things real data does: a missing
    interval, and a question with no answer key yet.

    Returns (score, status) where status is one of
    'ok' | 'missed' | 'unanswered' | 'ungraded'.
    """
    if answer is None:
        return 0.0, "ungraded"
    if interval is None:
        return UNANSWERED_PENALTY, "unanswered"
    a, b = interval
    s = score_i(a, b, answer)
    return s, ("ok" if a <= answer <= b else "missed")

def score_team(intervals, questions):
    """Score one team.

    intervals -- {question_id: (low, high)} for the team's final answers
    questions -- [{'id':..., 'answer': float|None}, ...]

    Returns a dict with the total and the per-question breakdown. Questions
    with no answer key are skipped entirely, so a partially keyed event still
    produces a usable provisional ranking.
    """
    total = 0.0
    correct = missed = unanswered = graded = 0
    breakdown = []

    for q in questions:
        interval = intervals.get(q["id"])
        s, status = score_question(interval, q.get("answer"))
        if status != "ungraded":
            graded += 1
            total += s
            if status == "ok":
                correct += 1
            elif status == "missed":
                missed += 1
            else:
                unanswered += 1
        breakdown.append({
            "question_id": q["id"],
            "low": interval[0] if interval else None,
            "high": interval[1] if interval else None,
            "answer": q.get("answer"),
            "score": round(s, 4),
            "status": status,
        })

    return {
        "score": round(total, 4),
        "correct": correct,
        "missed": missed,
        "unanswered": unanswered,
        "graded": graded,
        "answered": sum(1 for q in questions if q["id"] in intervals),
        "breakdown": breakdown,
    }


# ---------------------------------------------------------------------------
# Loading an event
# ---------------------------------------------------------------------------

def _latest_intervals(submissions):
    """{team_id: {question_id: (low, high)}} keeping only each team's most
    recent submission per question."""
    newest = {}
    for s in submissions:
        key = (s["teamId"], s["questionId"])
        if key not in newest or s["at"] >= newest[key]["at"]:
            newest[key] = s
    out = {}
    for (team_id, question_id), s in newest.items():
        out.setdefault(team_id, {})[question_id] = (float(s["low"]), float(s["high"]))
    return out


def load_sqlite(path):
    """Read an event straight out of the server's database."""
    con = sqlite3.connect("file:%s?mode=ro" % path, uri=True)
    con.row_factory = sqlite3.Row
    try:
        questions = [
            {"id": r["id"], "text": r["text"], "unit": r["unit"], "answer": r["answer"]}
            for r in con.execute("SELECT * FROM questions ORDER BY position")
        ]
        teams = [
            {"id": r["id"], "name": r["name"], "members": r["members"]}
            for r in con.execute("SELECT * FROM teams ORDER BY joined_at")
        ]
        submissions = [
            {"teamId": r["team_id"], "questionId": r["question_id"],
             "low": r["low"], "high": r["high"], "at": r["at"]}
            for r in con.execute("SELECT * FROM submissions ORDER BY at")
        ]
    finally:
        con.close()
    return questions, teams, submissions


def load_json(path):
    """Read an admin-page JSON export."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return data["config"]["questions"], data["teams"], data["submissions"]


def load_csv(path, questions):
    """Read an admin-page CSV export. Teams are inferred from the rows, so the
    question list has to come from somewhere else (the JS file, by default)."""
    submissions, teams, seen = [], [], {}
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            tid = row["team_id"]
            if tid not in seen:
                seen[tid] = True
                teams.append({"id": tid, "name": row["team"], "members": ""})
            submissions.append({
                "teamId": tid,
                "questionId": row["question_id"],
                "low": float(row["low"]),
                "high": float(row["high"]),
                # ISO timestamps sort lexicographically, which is all we need
                "at": row["submitted_at"],
            })
    return questions, teams, submissions


def leaderboard(questions, teams, submissions):
    """Every team scored and sorted, best (lowest) first."""
    per_team = _latest_intervals(submissions)
    rows = []
    for team in teams:
        result = score_team(per_team.get(team["id"], {}), questions)
        result["team"] = team["name"]
        result["team_id"] = team["id"]
        rows.append(result)
    rows.sort(key=lambda r: (r["score"], r["team"].lower()))
    return rows


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _print_table(rows, questions):
    graded = sum(1 for q in questions if q.get("answer") is not None)
    print()
    print("  %-4s %-28s %10s %8s %8s %8s" % ("#", "TEAM", "SCORE", "OK", "MISS", "BLANK"))
    print("  " + "-" * 70)
    for i, r in enumerate(rows, 1):
        print("  %-4d %-28s %10.3f %8d %8d %8d" % (
            i, r["team"][:28], r["score"], r["correct"], r["missed"], r["unanswered"]))
    print("  " + "-" * 70)
    print("  %d question%s keyed of %d%s" % (
        graded, "" if graded == 1 else "s", len(questions),
        "" if graded == len(questions) else "  (PROVISIONAL)"))
    print()


def _selftest():
    """Check the formula, and check that estimathon.js still agrees with it."""
    failures = []

    def check(label, got, want, tol=1e-9):
        if abs(got - want) > tol:
            failures.append("%s: got %r, wanted %r" % (label, got, want))

    # bracketed: only the width term
    check("exact hit", score_i(100, 100, 100), WIDTH_WEIGHT * 1)
    check("2x wide, bracketed", score_i(50, 100, 75), WIDTH_WEIGHT * 2)
    check("on the low edge", score_i(50, 100, 50), WIDTH_WEIGHT * 2)
    check("on the high edge", score_i(50, 100, 100), WIDTH_WEIGHT * 2)

    # missed low: answer above the interval, off by n/b
    check("guessed too low", score_i(10, 20, 40), WIDTH_WEIGHT * 2 + math.log2(2))
    # missed high: answer below the interval, off by a/n
    check("guessed too high", score_i(80, 160, 40), WIDTH_WEIGHT * 2 + math.log2(2))

    # a wide bracket beats a tight miss only up to a point
    if not score_i(1, 10, 5) < score_i(100, 100, 1600):
        failures.append("a 10x bracket should beat a 16x miss")

    # unanswered must be worse than any plausible answered question
    s, status = score_question(None, 500)
    check("unanswered", s, UNANSWERED_PENALTY)
    if status != "unanswered":
        failures.append("unanswered status was %r" % status)

    # the JS copy of the constants must match this file
    js = (ROOT / "estimathon" / "core.js").read_text(encoding="utf-8")
    for name, value in (("widthWeight", WIDTH_WEIGHT),
                        ("unansweredPenalty", UNANSWERED_PENALTY)):
        import re
        m = re.search(name + r":\s*([0-9.]+)", js)
        if not m:
            failures.append("estimathon.js has no %s in CONFIG_DEFAULTS" % name)
        elif abs(float(m.group(1)) - value) > 1e-12:
            failures.append("estimathon.js %s is %s, score.py says %s"
                            % (name, m.group(1), value))

    if failures:
        print("FAILED")
        for f in failures:
            print("  - " + f)
        return 1
    print("all scoring checks passed")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description="Score an Estimathon.")
    p.add_argument("source", nargs="?", default=str(ROOT / "estimathon.db"),
                   help="estimathon.db, or a JSON/CSV export from the admin page")
    p.add_argument("--json", action="store_true", help="print full results as JSON")
    p.add_argument("--out", metavar="FILE", help="also write the leaderboard to a CSV")
    p.add_argument("--selftest", action="store_true", help="check the formula and exit")
    args = p.parse_args(argv)

    if args.selftest:
        return _selftest()

    src = Path(args.source)
    if not src.exists():
        p.error("no such file: %s\n"
                "Run server.py to create estimathon.db, or export from the admin page."
                % src)

    if src.suffix == ".json":
        questions, teams, submissions = load_json(src)
    elif src.suffix == ".csv":
        from questions import load_questions
        questions, teams, submissions = load_csv(src, load_questions())
    else:
        questions, teams, submissions = load_sqlite(src)

    rows = leaderboard(questions, teams, submissions)

    if args.json:
        print(json.dumps({"questions": questions, "leaderboard": rows}, indent=2))
    else:
        _print_table(rows, questions)

    if args.out:
        with open(args.out, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["rank", "team", "score", "correct", "missed", "unanswered", "graded"])
            for i, r in enumerate(rows, 1):
                w.writerow([i, r["team"], r["score"], r["correct"],
                            r["missed"], r["unanswered"], r["graded"]])
        print("wrote %s" % args.out)

    return 0


if __name__ == "__main__":
    sys.exit(main())
