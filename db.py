"""
Tiny database adapter used by the cloud brain (cloud_app.py).

Works on two backends with the same code:
  - SQLite  (local dev)        -> when DATABASE_URL is unset
  - Postgres (Render, prod)    -> when DATABASE_URL is set

SQL is written with '?' placeholders and CURRENT_TIMESTAMP / ON CONFLICT,
which both backends understand (Python 3.11 bundles a modern SQLite).
"""

import os
from contextlib import contextmanager

DATABASE_URL = os.environ.get("DATABASE_URL")
IS_PG = bool(DATABASE_URL)

if IS_PG:
    import psycopg2
    import psycopg2.extras
    # Render/Heroku sometimes hand out the legacy "postgres://" scheme.
    _PG_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)
else:
    import sqlite3
    # Separate file from the offline app.py DB (different schema).
    SQLITE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "karaoke_cloud.db")

PK = "SERIAL PRIMARY KEY" if IS_PG else "INTEGER PRIMARY KEY AUTOINCREMENT"


def _connect():
    if IS_PG:
        return psycopg2.connect(_PG_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _conv(sql):
    return sql.replace("?", "%s") if IS_PG else sql


@contextmanager
def transaction():
    """Multiple statements in one committed transaction."""
    conn = _connect()
    try:
        cur = conn.cursor()
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def x(cur, sql, params=()):
    """Execute one statement on an open cursor (handles placeholder dialect)."""
    cur.execute(_conv(sql), params)


def fetchall(sql, params=()):
    with transaction() as cur:
        x(cur, sql, params)
        return [dict(r) for r in cur.fetchall()]


def fetchone(sql, params=()):
    with transaction() as cur:
        x(cur, sql, params)
        r = cur.fetchone()
        return dict(r) if r else None


def execute(sql, params=()):
    with transaction() as cur:
        x(cur, sql, params)


def insert(sql, params=()):
    """INSERT and return the new row id."""
    with transaction() as cur:
        if IS_PG:
            x(cur, sql + " RETURNING id", params)
            return cur.fetchone()["id"]
        x(cur, sql, params)
        return cur.lastrowid


def init_schema():
    with transaction() as cur:
        x(cur, f"""
            CREATE TABLE IF NOT EXISTS songs (
                id        {PK},
                song_key  TEXT UNIQUE NOT NULL,
                title     TEXT NOT NULL,
                artist    TEXT NOT NULL DEFAULT '',
                kind      TEXT NOT NULL
            )
        """)
        x(cur, f"""
            CREATE TABLE IF NOT EXISTS queue (
                id         {PK},
                song_id    INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
                singer     TEXT NOT NULL DEFAULT 'Guest',
                status     TEXT NOT NULL DEFAULT 'waiting',
                position   INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        x(cur, """
            CREATE TABLE IF NOT EXISTS player_state (
                id     INTEGER PRIMARY KEY,
                status TEXT NOT NULL DEFAULT 'stopped',
                volume REAL NOT NULL DEFAULT 1.0,
                seq    INTEGER NOT NULL DEFAULT 0
            )
        """)
        # Seed the single player_state row (id=1) once.
        x(cur, "SELECT id FROM player_state WHERE id=1")
        if not cur.fetchone():
            x(cur, "INSERT INTO player_state (id, status, volume, seq) "
                   "VALUES (1, 'stopped', 1.0, 0)")
