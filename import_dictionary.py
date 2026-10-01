"""One-time import: turn data/etlex.utf-8 (LEXiTRON English-Thai dictionary) into data/dictionary.db.

Run it once:   .venv/Scripts/python import_dictionary.py
The app then looks words up in dictionary.db. Run it again any time to rebuild the database.

Dictionary data: created by the adaptation of LEXiTRON developed by NECTEC (see data/LICENSE.txt).
"""
import re
import sqlite3
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
SOURCE = DATA_DIR / "etlex.utf-8"
TARGET = DATA_DIR / "dictionary.db"


def field(doc, tag):
    """Read <tag>value</tag> out of one <Doc> block (None if the tag is missing)."""
    m = re.search(rf"<{tag}>(.*?)</{tag}>", doc, flags=re.S)
    return m.group(1).strip() if m else None


def unescape(s):
    return s.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


def short_meaning(thai):
    """'เย็น (น้ำ, เครื่องดื่ม)' -> 'เย็น'. Keeps the original if nothing is left after removing the notes."""
    stripped = re.sub(r"\s*[\(\[][^\)\]]*[\)\]]", "", thai).strip()
    return stripped or thai


def main():
    text = SOURCE.read_text(encoding="utf-8")
    docs = re.findall(r"<Doc>(.*?)</Doc>", text, flags=re.S)

    rows, seen = [], set()
    for doc in docs:
        word, thai, pos = field(doc, "esearch"), field(doc, "tentry"), field(doc, "ecat")
        if not word or not thai:
            continue
        word, thai = unescape(word).lower(), unescape(thai)
        short = short_meaning(thai)
        key = (word, short, pos)
        if key in seen:          # the same word often repeats the same meaning
            continue
        seen.add(key)
        rows.append((word, pos or "", short, thai))

    if TARGET.exists():
        TARGET.unlink()
    with sqlite3.connect(TARGET) as conn:
        conn.execute("CREATE TABLE entries (word TEXT NOT NULL, pos TEXT NOT NULL, short TEXT NOT NULL, full TEXT NOT NULL)")
        conn.executemany("INSERT INTO entries VALUES (?, ?, ?, ?)", rows)
        conn.execute("CREATE INDEX idx_entries_word ON entries (word)")   # makes lookups instant

    print(f"Read {len(docs)} dictionary entries, saved {len(rows)} unique meanings to {TARGET}")


if __name__ == "__main__":
    main()
