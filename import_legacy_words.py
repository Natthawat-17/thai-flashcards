"""One-time helper: copy the words in the local SQLite file that belong to nobody (the ones saved before accounts
existed) into the database selected by DATABASE_URL (for example Neon), as ownerless words.

An ownerless word is invisible to everyone. It is handed to a person when they sign in with the Google account named
in LEGACY_OWNER_EMAIL (see google_login in app.py). Safe to run more than once: words already copied are skipped.

Run it:   .venv/Scripts/python import_legacy_words.py
"""
import sqlite3

import app  # loads your .env, so DATABASE_URL is picked up (the address itself is never printed)
import database

SOURCE = database.DB_PATH   # the local SQLite file


def main():
    if not database.using_postgres():
        print("DATABASE_URL is not set, so the app is using the local SQLite file already. Nothing to copy.")
        return
    if not SOURCE.exists():
        print(f"No local file at {SOURCE}. Nothing to copy.")
        return

    source = sqlite3.connect(SOURCE)
    source.row_factory = sqlite3.Row
    try:
        columns = [row["name"] for row in source.execute("PRAGMA table_info(words)")]
        if "user_id" not in columns:
            print("The local file has not been upgraded to accounts yet. Start the app once (python app.py) and run this again.")
            return
        legacy = source.execute(
            "SELECT english, thai, created FROM words WHERE user_id IS NULL ORDER BY english"
        ).fetchall()
    finally:
        source.close()
    print(f"Found {len(legacy)} ownerless words in the local file.")

    database.ensure_schema()
    copied = skipped = 0
    with database.get_db() as conn:
        for word in legacy:
            exists = conn.execute(
                "SELECT 1 FROM words WHERE user_id IS NULL AND english = ?", (word["english"],)
            ).fetchone()
            if exists:
                skipped += 1
                continue
            conn.execute(
                "INSERT INTO words (user_id, english, thai) VALUES (NULL, ?, ?)", (word["english"], word["thai"])
            )
            copied += 1
        total = conn.execute("SELECT COUNT(*) AS n FROM words WHERE user_id IS NULL").fetchone()["n"]
    print(f"Copied {copied}, skipped {skipped} that were already there. Ownerless words now in the online database: {total}.")


if __name__ == "__main__":
    main()
