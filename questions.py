"""Read DEFAULT_QUESTIONS out of estimathon.js.

estimathon.js is the single source of truth for the question set: edit the
array there and both the web pages and the Python side pick it up. This module
parses the JS array literal (unquoted keys, single-quoted strings, trailing
commas -- none of which json.loads accepts) into plain Python dicts.
"""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
JS_FILE = HERE / "estimathon.js"
ANSWERS_FILE = HERE / "answers.json"
MARKER = "var DEFAULT_QUESTIONS = ["


class QuestionParseError(Exception):
    pass


def _extract_array(js):
    """Return the source text of the DEFAULT_QUESTIONS array, brackets included."""
    start = js.find(MARKER)
    if start < 0:
        raise QuestionParseError("%s does not contain '%s'" % (JS_FILE.name, MARKER))
    start += len(MARKER) - 1  # land on the '['

    depth, i, n = 0, start, len(js)
    while i < n:
        c = js[i]
        if c in "'\"":
            i = _skip_string(js, i)
            continue
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return js[start:i + 1]
        i += 1
    raise QuestionParseError("DEFAULT_QUESTIONS array is never closed")


def _skip_string(src, i):
    """Given src[i] is a quote, return the index just past the closing quote."""
    quote, i, n = src[i], i + 1, len(src)
    while i < n:
        if src[i] == "\\":
            i += 2
            continue
        if src[i] == quote:
            return i + 1
        i += 1
    raise QuestionParseError("unterminated string in DEFAULT_QUESTIONS")


ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f",
           "\\": "\\", "'": "'", '"': '"', "/": "/"}


class _Parser:
    """Just enough of a JS value parser for an array of flat objects."""

    def __init__(self, src):
        self.src = src
        self.i = 0

    def error(self, msg):
        return QuestionParseError("%s at offset %d (near %r)"
                                  % (msg, self.i, self.src[max(0, self.i - 30):self.i + 30]))

    def ws(self):
        n = len(self.src)
        while self.i < n:
            c = self.src[self.i]
            if c in " \t\r\n":
                self.i += 1
            elif self.src.startswith("//", self.i):
                j = self.src.find("\n", self.i)
                self.i = n if j < 0 else j
            elif self.src.startswith("/*", self.i):
                j = self.src.find("*/", self.i)
                if j < 0:
                    raise self.error("unterminated comment")
                self.i = j + 2
            else:
                return

    def expect(self, ch):
        self.ws()
        if self.i >= len(self.src) or self.src[self.i] != ch:
            raise self.error("expected %r" % ch)
        self.i += 1

    def value(self):
        self.ws()
        if self.i >= len(self.src):
            raise self.error("unexpected end of input")
        c = self.src[self.i]
        if c == "[":
            return self.array()
        if c == "{":
            return self.obj()
        if c in "'\"":
            return self.string()
        for word, val in (("null", None), ("true", True), ("false", False)):
            if self.src.startswith(word, self.i):
                self.i += len(word)
                return val
        return self.number()

    def array(self):
        self.expect("[")
        out = []
        while True:
            self.ws()
            if self.i < len(self.src) and self.src[self.i] == "]":
                self.i += 1
                return out
            out.append(self.value())
            self.ws()
            if self.i < len(self.src) and self.src[self.i] == ",":
                self.i += 1  # trailing commas are fine
            elif self.i < len(self.src) and self.src[self.i] == "]":
                self.i += 1
                return out
            else:
                raise self.error("expected ',' or ']'")

    def obj(self):
        self.expect("{")
        out = {}
        while True:
            self.ws()
            if self.i < len(self.src) and self.src[self.i] == "}":
                self.i += 1
                return out
            key = self.key()
            self.expect(":")
            out[key] = self.value()
            self.ws()
            if self.i < len(self.src) and self.src[self.i] == ",":
                self.i += 1
            elif self.i < len(self.src) and self.src[self.i] == "}":
                self.i += 1
                return out
            else:
                raise self.error("expected ',' or '}'")

    def key(self):
        self.ws()
        if self.src[self.i] in "'\"":
            return self.string()
        start = self.i
        while self.i < len(self.src) and (self.src[self.i].isalnum() or self.src[self.i] in "_$"):
            self.i += 1
        if start == self.i:
            raise self.error("expected an object key")
        return self.src[start:self.i]

    def string(self):
        quote = self.src[self.i]
        self.i += 1
        out = []
        while self.i < len(self.src):
            c = self.src[self.i]
            if c == "\\":
                nxt = self.src[self.i + 1]
                if nxt == "u":
                    out.append(chr(int(self.src[self.i + 2:self.i + 6], 16)))
                    self.i += 6
                else:
                    out.append(ESCAPES.get(nxt, nxt))
                    self.i += 2
                continue
            if c == quote:
                self.i += 1
                return "".join(out)
            out.append(c)
            self.i += 1
        raise self.error("unterminated string")

    def number(self):
        start = self.i
        while self.i < len(self.src) and self.src[self.i] in "+-0123456789.eE":
            self.i += 1
        text = self.src[start:self.i]
        if not text:
            raise self.error("expected a value")
        try:
            return int(text) if ("." not in text and "e" not in text.lower()) else float(text)
        except ValueError:
            raise self.error("bad number %r" % text)


def load_answer_key(path=ANSWERS_FILE):
    """The answer key, if there is one on disk.

    Kept out of estimathon.js on purpose: that file is served to every team's
    browser. This one never is -- server.py refuses to serve it and .gitignore
    keeps it off the public Pages site. Missing file is fine; the organizers
    can type the answers into the dashboard instead.
    """
    if not Path(path).exists():
        return {}
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return {k: float(v) for k, v in data.items()
            if not k.startswith("_") and isinstance(v, (int, float))}


def load_questions(js_file=JS_FILE, answers=None):
    """The question set, in order, as [{'id','text','answer','unit'}, ...]."""
    js = Path(js_file).read_text(encoding="utf-8")
    questions = _Parser(_extract_array(js)).value()
    key = load_answer_key() if answers is None else answers

    seen = set()
    for i, q in enumerate(questions):
        if "id" not in q or "text" not in q:
            raise QuestionParseError("question %d is missing an id or text" % (i + 1))
        if q["id"] in seen:
            raise QuestionParseError("duplicate question id %r" % q["id"])
        seen.add(q["id"])
        q.setdefault("answer", None)
        q.setdefault("unit", "")
        # answers.json wins: estimathon.js should not carry the key at all.
        if q["id"] in key:
            q["answer"] = key[q["id"]]
        if q["answer"] is not None:
            q["answer"] = float(q["answer"])

    unknown = set(key) - seen
    if unknown:
        raise QuestionParseError(
            "answers.json has ids that are not questions: %s" % ", ".join(sorted(unknown)))
    return questions


if __name__ == "__main__":
    qs = load_questions()
    keyed = sum(1 for q in qs if q["answer"] is not None)
    print("%d questions, %d with an answer key\n" % (len(qs), keyed))
    for i, q in enumerate(qs, 1):
        answer = "unset" if q["answer"] is None else ("%g" % q["answer"])
        text = q["text"] if len(q["text"]) <= 68 else q["text"][:65] + "..."
        print("%2d. %-70s %14s %s" % (i, text, answer, q["unit"]))
