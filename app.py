import importlib.util
import json
import os
import re
import secrets
import sqlite3
import time
import urllib.error
import urllib.request
from datetime import timedelta
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory, session

from database import INTEGRITY_ERRORS, ensure_schema, get_db
from limits import LimitReached, allow_new_guest, charge_translation, check_word_cap

BASE_DIR = Path(__file__).parent


def load_env_file(path):
    """Read KEY=VALUE lines from a .env file into the environment, so you don't retype settings every time the
    server starts. A setting that is already in the environment wins over the file."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file(BASE_DIR / ".env")   # .env is private: it is not on the list of files the server sends to browsers

DICTIONARY_PATH = BASE_DIR / "data" / "dictionary.db"     # LEXiTRON meanings (built by import_dictionary.py)

# The page itself (HTML, CSS, JavaScript) lives in the public/ folder. Online, Vercel serves that folder directly;
# on your computer, the two routes below do the same job. Only these three files may be downloaded by visitors.
# Everything else in the project (app.py, flashcards.db, .env, .venv) stays private.
FRONTEND_DIR = BASE_DIR / "public"
FRONTEND_FILES = {"index.html", "style.css", "script.js"}

MAX_ENGLISH = 100
MAX_THAI = 200

# Lookups and translation
MAX_WORDS_PER_REQUEST = 20
MAX_MEANINGS = 6                        # meanings shown per word
MAX_SENTENCE = 300

app = Flask(__name__)

# Settings come from environment variables (or your .env file), never from the code:
#   SECRET_KEY   a long random string that signs the cookie that remembers who a visitor is. If it is not set, one
#                is created once and saved in the file .secret_key, so people stay recognised after a restart.

def get_secret_key():
    key = os.environ.get("SECRET_KEY")
    if key:
        return key
    if os.environ.get("VERCEL"):
        # Online, many copies of the app run at once and each would invent its own key, so a login made on one copy
        # would be rejected by the next. Refuse to start instead of failing in a confusing way.
        raise RuntimeError("SECRET_KEY is not set. Add it in the Vercel project settings (Environment Variables).")
    saved_file = BASE_DIR / ".secret_key"
    try:
        if saved_file.exists() and saved_file.read_text(encoding="utf-8").strip():
            return saved_file.read_text(encoding="utf-8").strip()
        key = secrets.token_hex(32)
        saved_file.write_text(key, encoding="utf-8")
        return key
    except OSError:
        return secrets.token_hex(32)   # can't write a file here (some hosts): fall back to a key for this run only


app.secret_key = get_secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,                          # JavaScript on the page can't read the cookie
    SESSION_COOKIE_SAMESITE="Lax",                         # other websites can't make your browser send it
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE") == "1",   # set COOKIE_SECURE=1 once the site uses https
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)


def clean(value):
    """Turn whatever the browser sent into a trimmed string ('' if it wasn't text)."""
    return value.strip() if isinstance(value, str) else ""


@app.before_request
def make_sure_tables_exist():
    """Online there is no start-up step we control, so check once per server process that the tables exist."""
    if request.path.startswith("/api/"):
        ensure_schema()


# ---------- Who is this visitor? ----------
# Nobody has to sign up. The first time a visitor saves a word, the server makes them a private guest account and
# remembers it in a signed cookie. (Signing in with Google, to keep words across devices, comes in a later step.)

def current_user_id(create=False):
    """The id of the user behind this browser, or None. With create=True a guest account is made if there isn't one."""
    user_id = session.get("user_id")
    if user_id:
        with get_db() as conn:
            if conn.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone():
                return user_id
        session.pop("user_id", None)   # the cookie names an account that no longer exists
    if not create:
        return None
    with get_db() as conn:
        allow_new_guest(conn)   # raises LimitReached if this network (or the site) made too many guests
        user_id = conn.execute("INSERT INTO users (kind) VALUES ('guest') RETURNING id").fetchone()["id"]
    session["user_id"] = user_id
    session.permanent = True           # keep the cookie for 30 days instead of until the browser closes
    return user_id


@app.errorhandler(LimitReached)
def too_much(error):
    """Any route can raise LimitReached; the page gets a plain-language message and a 429 status."""
    return jsonify(error=error.message), 429


@app.get("/api/session")
def session_status():
    """Who is this browser? user is null until the first word is saved, then {kind: "guest" | "google", email}.
    googleClientId is only there when Google sign-in is set up on this server (it is a public value, not a secret)."""
    google = google_client_id() or None
    user_id = current_user_id()
    if user_id is None:
        return jsonify(user=None, googleClientId=google)
    with get_db() as conn:
        row = conn.execute("SELECT kind, email FROM users WHERE id = ?", (user_id,)).fetchone()
    return jsonify(user={"kind": row["kind"], "email": row["email"]}, googleClientId=google)


# ---------- Sign in with Google ----------
# Settings (environment variables or your .env file):
#   GOOGLE_CLIENT_ID     from Google Cloud ("OAuth client ID", type Web). A public value, not a secret.
#   LEGACY_OWNER_EMAIL   optional: the Gmail address that owns the words saved before accounts existed.

def google_client_id():
    return os.environ.get("GOOGLE_CLIENT_ID", "").strip()


def verify_google_credential(credential):
    """Ask Google's public keys whether this sign-in proof is genuine. Returns its claims (sub, email, ...) or raises
    ValueError. google-auth checks the signature, the expiry, that Google issued it, and that it was made for OUR
    client id (so a proof made for some other website is refused)."""
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token

    claims = id_token.verify_oauth2_token(
        credential, google_requests.Request(), google_client_id(), clock_skew_in_seconds=10
    )
    if not claims.get("email_verified"):
        raise ValueError("The Google email address isn't verified.")
    return claims


def move_words(conn, from_user_id, to_user_id):
    """Give one user's words to another. from_user_id=None means the old words that belonged to nobody.
    A word the target already has is skipped, so nobody's existing meaning is overwritten."""
    if from_user_id is None:
        owner_test, owner_params = "user_id IS NULL", ()
    else:
        owner_test, owner_params = "user_id = ?", (from_user_id,)
    conn.execute(
        f"UPDATE words SET user_id = ? WHERE {owner_test} "
        "AND english NOT IN (SELECT english FROM words WHERE user_id = ?)",
        (to_user_id,) + owner_params + (to_user_id,),
    )


def find_or_create_google_user(conn, sub, email):
    row = conn.execute("SELECT id FROM users WHERE google_sub = ?", (sub,)).fetchone()
    if row:
        conn.execute("UPDATE users SET email = ? WHERE id = ?", (email, row["id"]))   # keep the address up to date
        return row["id"]
    return conn.execute(
        "INSERT INTO users (kind, google_sub, email) VALUES ('google', ?, ?) RETURNING id", (sub, email)
    ).fetchone()["id"]


@app.post("/api/google-login")
def google_login():
    if not google_client_id():
        return jsonify(error="Google sign-in isn't set up on this server."), 404
    credential = (request.get_json(silent=True) or {}).get("credential")
    if not isinstance(credential, str) or not credential:
        return jsonify(error="Google sign-in failed. Try again."), 400

    try:
        claims = verify_google_credential(credential)
    except ValueError:
        return jsonify(error="Google sign-in failed. Try again."), 401
    except Exception:   # for example Google's servers couldn't be reached to fetch their public keys
        return jsonify(error="Couldn't reach Google. Try again in a moment."), 502

    sub = clean(claims.get("sub"))
    email = clean(claims.get("email")).lower()
    if not sub or not email:
        return jsonify(error="Google sign-in failed. Try again."), 401

    guest_id = current_user_id()   # whoever this browser was a moment ago (may be a guest with words already)
    try:
        with get_db() as conn:
            user_id = find_or_create_google_user(conn, sub, email)
            if guest_id and guest_id != user_id:
                guest = conn.execute("SELECT kind FROM users WHERE id = ?", (guest_id,)).fetchone()
                if guest and guest["kind"] == "guest":
                    move_words(conn, guest_id, user_id)                        # keep what they saved as a guest
                    conn.execute("DELETE FROM users WHERE id = ?", (guest_id,))   # any skipped duplicates go with it
            owner_email = os.environ.get("LEGACY_OWNER_EMAIL", "").strip().lower()
            if owner_email and email == owner_email:
                move_words(conn, None, user_id)                                # the words saved before accounts existed
    except INTEGRITY_ERRORS:
        return jsonify(error="Couldn't finish signing in. Try again."), 409

    session.clear()               # start a fresh session for the signed-in account
    session["user_id"] = user_id
    session.permanent = True
    return jsonify(ok=True, user={"kind": "google", "email": email})


@app.post("/api/logout")
def logout():
    """Sign out of a Google account. A guest has nothing to sign out of: their words only live in this browser's cookie."""
    user_id = current_user_id()
    if user_id is not None:
        with get_db() as conn:
            row = conn.execute("SELECT kind FROM users WHERE id = ?", (user_id,)).fetchone()
        if row and row["kind"] == "guest":
            return jsonify(error="Guests can't sign out. Sign in with Google to keep your words."), 400
    session.clear()
    return jsonify(ok=True)


# ---------- Pages: send the frontend files to the browser ----------

@app.get("/")
def home():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/<name>")
def frontend_file(name):
    if name not in FRONTEND_FILES:
        abort(404)
    return send_from_directory(FRONTEND_DIR, name)


# ---------- API routes (the page talks to these with fetch) ----------
# Every word belongs to a user, and every query below filters on user_id, so nobody can read or change
# another person's words even by guessing a word's id number.

@app.get("/api/words")
def list_words():
    user_id = current_user_id()
    if user_id is None:
        return jsonify([])   # a brand-new visitor has no words yet
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, english, thai FROM words WHERE user_id = ? ORDER BY english", (user_id,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/words")
def add_word():
    data = request.get_json(silent=True) or {}
    english = clean(data.get("english")).lower()
    thai = clean(data.get("thai"))

    if not english or not thai:
        return jsonify(error="Both 'english' and 'thai' are required."), 400
    if len(english) > MAX_ENGLISH or len(thai) > MAX_THAI:
        return jsonify(error="That text is too long."), 400

    user_id = current_user_id(create=True)
    try:
        with get_db() as conn:
            check_word_cap(conn, user_id)
            word_id = conn.execute(
                "INSERT INTO words (user_id, english, thai) VALUES (?, ?, ?) RETURNING id", (user_id, english, thai)
            ).fetchone()["id"]
    except INTEGRITY_ERRORS:   # UNIQUE (user_id, english): this person already has the word
        return jsonify(error=f"'{english}' already exists."), 409

    return jsonify(id=word_id, english=english, thai=thai), 201


@app.put("/api/words/<int:word_id>")
def update_word(word_id):
    """Change the Thai meaning of one of your words (the English stays the same)."""
    data = request.get_json(silent=True) or {}
    thai = clean(data.get("thai"))

    if not thai:
        return jsonify(error="'thai' is required."), 400
    if len(thai) > MAX_THAI:
        return jsonify(error="That text is too long."), 400

    user_id = current_user_id()
    if user_id is None:
        return jsonify(error="Word not found."), 404
    with get_db() as conn:
        # "AND user_id = ?" is the important part: a word that isn't yours behaves as if it doesn't exist.
        cur = conn.execute("UPDATE words SET thai = ? WHERE id = ? AND user_id = ?", (thai, word_id, user_id))
        if cur.rowcount == 0:
            return jsonify(error="Word not found."), 404
        row = conn.execute("SELECT id, english, thai FROM words WHERE id = ?", (word_id,)).fetchone()
    return jsonify(dict(row))


@app.delete("/api/words/<int:word_id>")
def delete_word(word_id):
    user_id = current_user_id()
    if user_id is None:
        return jsonify(error="Word not found."), 404
    with get_db() as conn:
        cur = conn.execute("DELETE FROM words WHERE id = ? AND user_id = ?", (word_id, user_id))
    if cur.rowcount == 0:
        return jsonify(error="Word not found."), 404
    return "", 204


# ---------- Word meanings: LEXiTRON dictionary ----------
# Dictionary data: created by the adaptation of LEXiTRON developed by NECTEC (see data/LICENSE.txt).

# Phrasal verbs, idioms, abbreviations and similar are shown after ordinary meanings.
LOW_PRIORITY_POS = {"PHRV", "IDM", "SL", "ABBR", "PRF", "SUF"}


def dictionary_enabled():
    return DICTIONARY_PATH.exists()


def lookup_word(conn, word):
    """Return up to MAX_MEANINGS distinct Thai meanings for an English word, most useful first."""
    rows = conn.execute("SELECT pos, short, full FROM entries WHERE word = ?", (word,)).fetchall()
    # Best guess first: ordinary meanings before phrases/idioms, then before entries that describe an English
    # letter or sound (they mention "ภาษาอังกฤษ", English language), then shorter Thai answers (usually the plain translation).
    rows.sort(key=lambda r: (r[0] in LOW_PRIORITY_POS, "ภาษาอังกฤษ" in r[1], len(r[1]), r[1]))
    meanings, seen = [], set()
    for pos, short, full in rows:
        if short in seen:
            continue
        seen.add(short)
        meanings.append({"thai": short, "pos": pos, "note": full if full != short else ""})
        if len(meanings) == MAX_MEANINGS:
            break
    return meanings


@app.get("/api/lookup")
def lookup():
    """GET /api/lookup?words=drink,cold  ->  { "drink": [ {thai, pos, note}, ... ], "cold": [...] }"""
    if not dictionary_enabled():
        return jsonify(error="The dictionary isn't set up on this server."), 503
    raw = request.args.get("words", "")
    words = list(dict.fromkeys(w for w in (clean(x).lower()[:40] for x in raw.split(",")) if w))
    if not 1 <= len(words) <= MAX_WORDS_PER_REQUEST:
        return jsonify(error=f"Send between 1 and {MAX_WORDS_PER_REQUEST} words."), 400
    # mode=ro opens the file read-only, so a lookup can never change the dictionary.
    with sqlite3.connect(f"file:{DICTIONARY_PATH.as_posix()}?mode=ro", uri=True) as conn:
        return jsonify({w: lookup_word(conn, w) for w in words})


# ---------- Grammar labels: spaCy (runs on this computer, no key, no internet) ----------
# spaCy reads the English sentence and says what each word is *in that sentence*:
# "I love you" -> I = pronoun, love = verb, you = pronoun.

# spaCy's grammar codes -> the short names shown on the page (the same names the dictionary labels use).
POS_NAMES = {
    "NOUN": "noun", "PROPN": "noun", "VERB": "verb", "AUX": "verb", "ADJ": "adj.", "ADV": "adv.",
    "PRON": "pronoun", "ADP": "prep.", "CCONJ": "conj.", "SCONJ": "conj.", "DET": "det.",
    "NUM": "number", "INTJ": "interj.",
}
_tagger = None
_tagger_failed = False


def tagger_available():
    """True if spaCy and its small English model are installed (checked without loading them)."""
    return importlib.util.find_spec("spacy") is not None and importlib.util.find_spec("en_core_web_sm") is not None


def get_tagger():
    """Load the model the first time it is needed (about a second), then reuse it."""
    global _tagger, _tagger_failed
    if _tagger is None and not _tagger_failed:
        try:
            import spacy
            # Only the parts that decide the word type; the rest would just slow things down.
            _tagger = spacy.load("en_core_web_sm", disable=["parser", "ner", "lemmatizer"])
        except Exception:
            _tagger_failed = True
    return _tagger


@app.post("/api/tag")
def tag_words():
    """Body: { "sentence": "I love you", "words": ["i", "love", "you"] }  ->  { "labels": { "love": "verb", ... } }"""
    nlp = get_tagger() if tagger_available() else None
    if nlp is None:
        return jsonify(error="Grammar labels aren't set up on this server."), 503

    data = request.get_json(silent=True) or {}
    sentence = clean(data.get("sentence"))
    raw_words = data.get("words")
    if not sentence or len(sentence) > MAX_SENTENCE:
        return jsonify(error=f"Send a sentence of 1 to {MAX_SENTENCE} characters."), 400
    if not isinstance(raw_words, list) or not 1 <= len(raw_words) <= MAX_WORDS_PER_REQUEST:
        return jsonify(error=f"Send between 1 and {MAX_WORDS_PER_REQUEST} words."), 400
    words = list(dict.fromkeys(w for w in (clean(x).lower()[:40] for x in raw_words if isinstance(x, str)) if w))

    # People type "i" in lowercase; the capital makes it clear it is the pronoun. Same length, so positions still line up.
    doc = nlp(re.sub(r"\bi\b", "I", sentence))
    token_at = {token.idx: token for token in doc}   # character position -> token
    lowered = sentence.lower()

    labels = {}
    for word in words:
        # Find the word in the sentence as a whole word, then read the label of the token that starts there.
        match = re.search(r"(?<![\w'-])" + re.escape(word) + r"(?![\w'-])", lowered)
        token = token_at.get(match.start()) if match else None
        label = POS_NAMES.get(token.pos_) if token else None
        if label:
            labels[word] = label
    return jsonify(labels=labels)


# ---------- Sentence translation: DeepL ----------
# The key comes from the DEEPL_API_KEY environment variable. It is never written in the code,
# never sent to the browser, and never saved in a file.

def deepl_key():
    return os.environ.get("DEEPL_API_KEY", "").strip()


def deepl_enabled():
    return bool(deepl_key())


def deepl_url():
    custom = os.environ.get("DEEPL_API_URL")
    if custom:
        return custom
    # Free keys end in ":fx" and use a different address from paid keys.
    host = "api-free.deepl.com" if deepl_key().endswith(":fx") else "api.deepl.com"
    return f"https://{host}/v2/translate"


class DeepLError(Exception):
    """A problem talking to DeepL, with a message that is safe to show (it never contains the key)."""

    def __init__(self, message, status):
        super().__init__(message)
        self.message = message
        self.status = status


def deepl_translate(texts, context=""):
    """Send English texts to DeepL and return the Thai texts, in the same order."""
    body = {"text": texts, "source_lang": "EN", "target_lang": "TH"}
    if context:
        # Extra context helps DeepL pick the right meaning of a short word. DeepL does not translate it or bill it.
        body["context"] = context
    deepl_request = urllib.request.Request(
        deepl_url(),
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": "DeepL-Auth-Key " + deepl_key(), "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(deepl_request, timeout=15) as reply:
            payload = json.load(reply)
    except urllib.error.HTTPError as e:
        known = {
            403: ("The DeepL key was rejected.", 502),
            456: ("DeepL's monthly character limit has been reached.", 429),
            429: ("DeepL is busy. Try again in a moment.", 429),
        }
        message, status = known.get(e.code, ("DeepL is unavailable. Try again in a moment.", 502))
        raise DeepLError(message, status)
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise DeepLError("DeepL is unavailable. Try again in a moment.", 502)

    translations = payload.get("translations") if isinstance(payload, dict) else None
    if not translations or len(translations) != len(texts):
        raise DeepLError("DeepL returned no translation.", 502)
    return [clean(t.get("text")) for t in translations]


@app.get("/api/config")
def config():
    """Lets the page ask which optional features this server has."""
    return jsonify(translate=deepl_enabled(), dictionary=dictionary_enabled(), tagger=tagger_available())


@app.post("/api/translate")
def translate_sentence():
    """Body: { "sentence": "I love you", "words": ["i", "love", "you"] }  (words is optional).
    Returns the whole sentence in Thai, plus each word translated in the context of that sentence."""
    if not deepl_enabled():
        return jsonify(error="Sentence translation isn't set up on this server."), 503

    data = request.get_json(silent=True) or {}
    sentence = clean(data.get("sentence"))
    if not sentence:
        return jsonify(error="Type a sentence first."), 400
    if len(sentence) > MAX_SENTENCE:
        return jsonify(error=f"Keep the sentence under {MAX_SENTENCE} characters."), 400

    raw_words = data.get("words", [])
    if not isinstance(raw_words, list) or len(raw_words) > MAX_WORDS_PER_REQUEST:
        return jsonify(error=f"Send at most {MAX_WORDS_PER_REQUEST} words."), 400
    words = list(dict.fromkeys(w for w in (clean(x).lower()[:40] for x in raw_words if isinstance(x, str)) if w))

    # Count this translation against the person's daily limits and the site's shared DeepL quota, before spending any.
    user_id = current_user_id(create=True)
    characters = len(sentence) + sum(len(w) for w in words)   # what DeepL will bill (the context is free)
    with get_db() as conn:
        translations_left = charge_translation(conn, user_id, characters)

    try:
        sentence_thai = deepl_translate([sentence])[0]
        word_thai = {}
        if words:
            # The pronoun "I" is lowercased by the page; give DeepL the capital so it isn't read as a letter.
            shown = ["I" if w == "i" else w for w in words]
            translated = deepl_translate(shown, context=sentence)
            word_thai = {w: t[:80] for w, t in zip(words, translated) if t}
    except DeepLError as e:
        return jsonify(error=e.message), e.status

    if not sentence_thai:
        return jsonify(error="DeepL returned no translation."), 502
    return jsonify(sentence=sentence_thai[:MAX_SENTENCE * 3], words=word_thai, translationsLeft=translations_left)


if __name__ == "__main__":
    ensure_schema()
    if tagger_available():
        get_tagger()   # load the grammar model now, so the first translation isn't slower than the rest
    # Hosting services tell the app which port to use through the PORT variable; locally it stays 5000.
    app.run(debug=True, port=int(os.environ.get("PORT", 5000)))
