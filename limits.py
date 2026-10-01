"""Usage limits: protect the shared DeepL quota and the database from heavy use and bots.

The counters live in the database (table usage_counts), not in the server's memory. That matters online: Vercel can
run each request on a different copy of the app, and a counter kept in memory would start from zero every time.

A counter is one row: who (subject), which window (bucket, such as a day), what (kind), and how many (n).
"""
import hashlib
import os
import random
from datetime import datetime, timedelta, timezone

from flask import current_app, request

from database import ago_sql

# What each kind of user may do. A guest is a visitor who has not signed in with Google.
LIMITS = {
    "guest": {"translations_per_day": 15, "chars_per_day": 1500, "words": 200},
    "google": {"translations_per_day": 60, "chars_per_day": 6000, "words": 2000},
}
NEW_GUESTS_PER_IP_PER_HOUR = 10   # one network can create this many guest accounts per hour
NEW_GUESTS_PER_DAY = 500          # and the whole site this many per day


def global_daily_chars():
    """The most characters we send to DeepL per day, for everyone together. DeepL's free plan is 500,000 a month;
    15,000 a day is about 450,000 a month, which leaves some room. Change it with DEEPL_GLOBAL_DAILY_CHARS."""
    try:
        return int(os.environ.get("DEEPL_GLOBAL_DAILY_CHARS", "15000"))
    except ValueError:
        return 15000


class LimitReached(Exception):
    """Raised when someone is over a limit. app.py turns it into a clear HTTP 429 message for the page."""

    def __init__(self, message):
        super().__init__(message)
        self.message = message


def now_utc():
    return datetime.now(timezone.utc)   # a function so tests can pretend it is tomorrow


def day_bucket():
    return now_utc().strftime("%Y-%m-%d")


def hour_bucket():
    return now_utc().strftime("%Y-%m-%d-%H")


def client_subject():
    """A private label for the visitor's network address. The address is hashed together with the secret key,
    so the database never holds anyone's real IP address."""
    address = request.remote_addr or "unknown"
    if os.environ.get("TRUST_PROXY") == "1":
        # Behind a host such as Vercel, remote_addr is the host's own machine; the real visitor is in this header.
        # Only trust it when told to, because anyone can send a fake header to a server that is not behind a proxy.
        forwarded = request.headers.get("X-Forwarded-For", "")
        address = forwarded.split(",")[0].strip() or address
    secret = str(current_app.secret_key)
    return "ip:" + hashlib.sha256((secret + address).encode("utf-8")).hexdigest()[:16]


def count_up(conn, subject, kind, bucket, amount):
    """Add `amount` to a counter in one atomic step (so two requests at the same moment can't lose a count)
    and return the new total."""
    return conn.execute(
        "INSERT INTO usage_counts (subject, bucket, kind, n) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (subject, bucket, kind) DO UPDATE SET n = usage_counts.n + ? RETURNING n",
        (subject, bucket, kind, amount, amount),
    ).fetchone()["n"]


def maintenance(conn):
    """Housekeeping, run now and then: forget old counters and delete guest accounts that were never used."""
    cutoff = (now_utc() - timedelta(days=3)).strftime("%Y-%m-%d")
    conn.execute("DELETE FROM usage_counts WHERE bucket < ?", (cutoff,))
    conn.execute(
        f"DELETE FROM users WHERE kind = 'guest' AND created < {ago_sql(30)} "
        "AND NOT EXISTS (SELECT 1 FROM words WHERE words.user_id = users.id)"
    )


def allow_new_guest(conn):
    """Call before creating a guest account. Raises LimitReached if this network (or the whole site) made too many."""
    if count_up(conn, client_subject(), "new_guests", hour_bucket(), 1) > NEW_GUESTS_PER_IP_PER_HOUR:
        raise LimitReached("Too many new guest accounts from your network. Try again in an hour, or sign in with Google.")
    if count_up(conn, "all", "new_guests", day_bucket(), 1) > NEW_GUESTS_PER_DAY:
        raise LimitReached("The site has reached its limit for new guests today. Try again tomorrow.")
    if random.random() < 0.05:   # about one in twenty guest sign-ups also tidies up
        maintenance(conn)


def check_word_cap(conn, user_id):
    """Call before saving a new word. Raises LimitReached if this person's list is full."""
    row = conn.execute(
        "SELECT u.kind AS kind, (SELECT COUNT(*) FROM words w WHERE w.user_id = u.id) AS total "
        "FROM users u WHERE u.id = ?",
        (user_id,),
    ).fetchone()
    kind = row["kind"] if row and row["kind"] in LIMITS else "guest"
    cap = LIMITS[kind]["words"]
    if row and row["total"] >= cap:
        extra = " Sign in with Google to keep up to %d." % LIMITS["google"]["words"] if kind == "guest" else ""
        raise LimitReached(f"Your word list is full ({cap} words). Delete some to add more.{extra}")


def charge_translation(conn, user_id, characters):
    """Call before sending text to DeepL. Counts one translation and `characters` characters against this person and
    against the whole site. Raises LimitReached if any limit is passed (and, because the whole request is then undone,
    nothing is counted for a refused translation). Returns how many translations this person has left today."""
    row = conn.execute("SELECT kind FROM users WHERE id = ?", (user_id,)).fetchone()
    kind = row["kind"] if row and row["kind"] in LIMITS else "guest"
    limit = LIMITS[kind]
    subject, day = f"user:{user_id}", day_bucket()
    hint = " Dictionary meanings still work." + (" Sign in with Google for more." if kind == "guest" else "")

    used = count_up(conn, subject, "translations", day, 1)
    if used > limit["translations_per_day"]:
        raise LimitReached(f"You've used your {limit['translations_per_day']} translations for today. Come back tomorrow.{hint}")
    if count_up(conn, subject, "chars", day, characters) > limit["chars_per_day"]:
        raise LimitReached(f"You've reached today's text limit for translation. Come back tomorrow.{hint}")
    if count_up(conn, "all", "deepl_chars", day, characters) > global_daily_chars():
        raise LimitReached("Translation is paused for today to stay within the free quota. Dictionary meanings still work. Try again tomorrow.")
    return limit["translations_per_day"] - used
