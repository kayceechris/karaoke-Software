"""
LAN Karaoke Server
==================

A single-file Flask app that turns a laptop into a karaoke server:

  - Tablet  (customer):  http://<laptop-ip>:5000/tablet   -> search + request songs
  - Admin   (laptop):    http://<laptop-ip>:5000/admin     -> play/pause/next/remove
  - Player  (TV screen): http://<laptop-ip>:5000/player    -> fullscreen playback

Songs are read from the local SONGS_DIR folder. Supported formats:
  - "Artist - Title.mp4"            (video karaoke)
  - "Artist - Title.mp3" + .cdg     (classic MP3+CDG; .cdg must share the basename)
  - "Artist - Title.mp3"            (audio only, no graphics)

Run:  python app.py
"""

import io
import os
import socket
import sqlite3
import time
from contextlib import closing

import qrcode
import qrcode.image.svg
from flask import (
    Flask, g, jsonify, render_template, request,
    send_file, abort, Response,
)

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SONGS_DIR = os.environ.get("KARAOKE_SONGS_DIR", os.path.join(BASE_DIR, "songs"))
DB_PATH = os.path.join(BASE_DIR, "karaoke.db")
PORT = int(os.environ.get("KARAOKE_PORT", "5000"))

VIDEO_EXTS = {".mp4", ".webm", ".m4v"}
AUDIO_EXTS = {".mp3", ".m4a", ".ogg", ".wav"}

app = Flask(__name__)


# --------------------------------------------------------------------------
# Database helpers
# --------------------------------------------------------------------------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    with closing(sqlite3.connect(DB_PATH)) as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS songs (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                title     TEXT NOT NULL,
                artist    TEXT NOT NULL DEFAULT '',
                kind      TEXT NOT NULL,            -- 'video' | 'cdg' | 'audio'
                file_path TEXT NOT NULL UNIQUE,     -- mp4/mp3 path
                cdg_path  TEXT                      -- companion .cdg (cdg kind only)
            );

            CREATE TABLE IF NOT EXISTS queue (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                song_id     INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
                singer      TEXT NOT NULL DEFAULT 'Guest',
                status      TEXT NOT NULL DEFAULT 'waiting',  -- waiting | playing | done
                position    INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS player_state (
                id          INTEGER PRIMARY KEY CHECK (id = 1),
                status      TEXT NOT NULL DEFAULT 'stopped',  -- playing | paused | stopped
                volume      REAL NOT NULL DEFAULT 1.0,
                seq         INTEGER NOT NULL DEFAULT 0,        -- bumps on every command
                position    REAL NOT NULL DEFAULT 0,           -- last reported playback time
                duration    REAL NOT NULL DEFAULT 0,
                seek_to     REAL,                              -- pending seek target (null = none)
                position_at REAL                               -- server clock when position was recorded
            );

            INSERT OR IGNORE INTO player_state (id, status, volume, seq)
            VALUES (1, 'stopped', 1.0, 0);
            """
        )
        # Migrate DBs created before position/duration/seek_to existed. Each in
        # its own try so a pre-existing column doesn't abort the rest.
        for _col in [
            "ALTER TABLE player_state ADD COLUMN position REAL NOT NULL DEFAULT 0",
            "ALTER TABLE player_state ADD COLUMN duration REAL NOT NULL DEFAULT 0",
            "ALTER TABLE player_state ADD COLUMN seek_to  REAL",
            "ALTER TABLE player_state ADD COLUMN position_at REAL",
        ]:
            try:
                db.execute(_col)
            except sqlite3.OperationalError:
                pass  # column already exists
        db.commit()


# --------------------------------------------------------------------------
# Song library indexing
# --------------------------------------------------------------------------
def parse_name(basename):
    """'Artist - Title' -> (artist, title); falls back to ('', basename)."""
    name = os.path.splitext(basename)[0]
    if " - " in name:
        artist, title = name.split(" - ", 1)
        return artist.strip(), title.strip()
    return "", name.strip()


def index_songs():
    """Scan SONGS_DIR and sync the songs table. Idempotent."""
    os.makedirs(SONGS_DIR, exist_ok=True)
    found = {}  # file_path -> row dict

    for root, _dirs, files in os.walk(SONGS_DIR):
        lower = {f.lower(): f for f in files}
        for fname in files:
            ext = os.path.splitext(fname)[1].lower()
            full = os.path.join(root, fname)
            artist, title = parse_name(fname)

            if ext in VIDEO_EXTS:
                found[full] = dict(title=title, artist=artist,
                                   kind="video", cdg_path=None)
            elif ext in AUDIO_EXTS:
                cdg_name = os.path.splitext(fname)[0] + ".cdg"
                cdg_full = os.path.join(root, lower.get(cdg_name.lower(), ""))
                if os.path.isfile(cdg_full):
                    found[full] = dict(title=title, artist=artist,
                                       kind="cdg", cdg_path=cdg_full)
                else:
                    found[full] = dict(title=title, artist=artist,
                                       kind="audio", cdg_path=None)

    with closing(sqlite3.connect(DB_PATH)) as db:
        db.row_factory = sqlite3.Row
        existing = {r["file_path"]: r["id"]
                    for r in db.execute("SELECT id, file_path FROM songs")}

        # Add new files
        for path, meta in found.items():
            if path not in existing:
                db.execute(
                    "INSERT INTO songs (title, artist, kind, file_path, cdg_path) "
                    "VALUES (?,?,?,?,?)",
                    (meta["title"], meta["artist"], meta["kind"],
                     path, meta["cdg_path"]),
                )

        # Remove songs whose files are gone (only if not referenced by queue)
        for path, sid in existing.items():
            if path not in found:
                in_queue = db.execute(
                    "SELECT 1 FROM queue WHERE song_id=? LIMIT 1", (sid,)
                ).fetchone()
                if not in_queue:
                    db.execute("DELETE FROM songs WHERE id=?", (sid,))

        db.commit()
        return len(found)


# --------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------
@app.route("/")
def home():
    return render_template("home.html", ip=local_ip(), port=PORT)


@app.route("/tablet")
def tablet():
    return render_template("tablet.html")


@app.route("/admin")
def admin():
    return render_template("admin.html")


@app.route("/sw.js")
def sw():
    resp = send_file(os.path.join(app.static_folder, "sw.js"),
                     mimetype="application/javascript")
    resp.headers["Service-Worker-Allowed"] = "/"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/manifest.webmanifest")
def manifest():
    return send_file(os.path.join(app.static_folder, "manifest.webmanifest"),
                     mimetype="application/manifest+json")


@app.route("/admin-manifest.webmanifest")
def admin_manifest():
    return send_file(os.path.join(app.static_folder, "admin-manifest.webmanifest"),
                     mimetype="application/manifest+json")


def _tablet_url():
    return f"http://{local_ip()}:{PORT}/tablet"


@app.route("/qr.svg")
def qr_svg():
    img = qrcode.make(_tablet_url(),
                      image_factory=qrcode.image.svg.SvgPathImage,
                      box_size=12, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return Response(buf.getvalue(), mimetype="image/svg+xml")


@app.route("/qr")
def qr_page():
    return render_template("qr.html", url=_tablet_url())


@app.route("/player")
def player():
    return render_template("player.html")


# --------------------------------------------------------------------------
# Song API
# --------------------------------------------------------------------------
@app.route("/api/songs")
def api_songs():
    q = request.args.get("q", "").strip()
    db = get_db()
    if q:
        like = f"%{q}%"
        rows = db.execute(
            "SELECT id, title, artist, kind FROM songs "
            "WHERE title LIKE ? OR artist LIKE ? "
            "ORDER BY artist, title LIMIT 200",
            (like, like),
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT id, title, artist, kind FROM songs "
            "ORDER BY artist, title LIMIT 200"
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/reindex", methods=["POST"])
def api_reindex():
    count = index_songs()
    return jsonify(ok=True, count=count)


# --------------------------------------------------------------------------
# Queue API
# --------------------------------------------------------------------------
def queue_rows(db):
    return db.execute(
        """
        SELECT q.id, q.singer, q.status, q.position,
               s.id AS song_id, s.title, s.artist, s.kind
        FROM queue q JOIN songs s ON s.id = q.song_id
        WHERE q.status IN ('waiting', 'playing')
        ORDER BY (q.status='playing') DESC, q.position ASC, q.id ASC
        """
    ).fetchall()


@app.route("/api/queue")
def api_queue():
    db = get_db()
    return jsonify([dict(r) for r in queue_rows(db)])


@app.route("/api/queue", methods=["POST"])
def api_queue_add():
    data = request.get_json(force=True)
    song_id = data.get("song_id")
    singer = (data.get("singer") or "Guest").strip()[:40] or "Guest"
    db = get_db()
    if not db.execute("SELECT 1 FROM songs WHERE id=?", (song_id,)).fetchone():
        abort(404)
    nextpos = db.execute(
        "SELECT COALESCE(MAX(position),0)+1 FROM queue WHERE status='waiting'"
    ).fetchone()[0]
    db.execute(
        "INSERT INTO queue (song_id, singer, position) VALUES (?,?,?)",
        (song_id, singer, nextpos),
    )
    db.commit()
    return jsonify(ok=True)


@app.route("/api/queue/<int:qid>", methods=["DELETE"])
def api_queue_remove(qid):
    db = get_db()
    db.execute("DELETE FROM queue WHERE id=?", (qid,))
    db.commit()
    return jsonify(ok=True)


@app.route("/api/queue/<int:qid>/top", methods=["POST"])
def api_queue_top(qid):
    """Bump a waiting item to the front of the waiting list."""
    db = get_db()
    minpos = db.execute(
        "SELECT COALESCE(MIN(position),1) FROM queue WHERE status='waiting'"
    ).fetchone()[0]
    db.execute("UPDATE queue SET position=? WHERE id=? AND status='waiting'",
               (minpos - 1, qid))
    db.commit()
    return jsonify(ok=True)


@app.route("/api/queue/<int:qid>/move", methods=["POST"])
def api_queue_move(qid):
    """Swap a waiting item with its immediate neighbor (direction: up/down)."""
    data = request.get_json(force=True)
    direction = data.get("direction")
    if direction not in ("up", "down"):
        abort(400)
    db = get_db()
    rows = db.execute(
        "SELECT id, position FROM queue WHERE status='waiting' "
        "ORDER BY position ASC, id ASC"
    ).fetchall()
    ids = [r["id"] for r in rows]
    if qid not in ids:
        abort(404)
    idx = ids.index(qid)
    swap_idx = idx - 1 if direction == "up" else idx + 1
    if 0 <= swap_idx < len(ids):
        a, b = rows[idx], rows[swap_idx]
        db.execute("UPDATE queue SET position=? WHERE id=?", (b["position"], a["id"]))
        db.execute("UPDATE queue SET position=? WHERE id=?", (a["position"], b["id"]))
        db.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------
# Player control + state
# --------------------------------------------------------------------------
def current_playing(db):
    return db.execute(
        """
        SELECT q.id AS queue_id, q.singer,
               s.id AS song_id, s.title, s.artist, s.kind
        FROM queue q JOIN songs s ON s.id = q.song_id
        WHERE q.status='playing' LIMIT 1
        """
    ).fetchone()


def advance(db):
    """Mark current playing as done and promote the next waiting song."""
    db.execute("UPDATE queue SET status='done' WHERE status='playing'")
    nxt = db.execute(
        "SELECT id FROM queue WHERE status='waiting' "
        "ORDER BY position ASC, id ASC LIMIT 1"
    ).fetchone()
    if nxt:
        db.execute("UPDATE queue SET status='playing' WHERE id=?", (nxt["id"],))
        db.execute("UPDATE player_state SET status='playing', seek_to=NULL, "
                   "position=0, duration=0, position_at=? WHERE id=1", (time.time(),))
    else:
        db.execute("UPDATE player_state SET status='stopped', seek_to=NULL, "
                   "position=0, duration=0, position_at=? WHERE id=1", (time.time(),))


def _extrapolate(st):
    """The host only reports its position every few seconds — extrapolate
    from the server clock so any client (a fresh tablet join, or an
    already-playing one correcting drift) gets an accurate "right now"
    position instead of a stale one."""
    pos = st["position"] or 0
    dur = st["duration"] or 0
    at = st["position_at"]
    if st["status"] == "playing" and at:
        pos += max(0, time.time() - at)
        if dur:
            pos = min(pos, dur)
    return pos, dur


@app.route("/api/player/state")
def api_player_state():
    db = get_db()
    st = db.execute(
        "SELECT status, volume, seq, position, duration, seek_to, position_at "
        "FROM player_state WHERE id=1"
    ).fetchone()
    cur = current_playing(db)
    pos, dur = _extrapolate(st)
    return jsonify(
        status=st["status"],
        volume=st["volume"],
        seq=st["seq"],
        position=pos,
        duration=dur,
        seek_to=st["seek_to"],
        current=dict(cur) if cur else None,
    )


@app.route("/api/player/command", methods=["POST"])
def api_player_command():
    data = request.get_json(force=True)
    action = data.get("action")
    db = get_db()

    if action == "play":
        # If nothing is playing, promote the first waiting song.
        if not current_playing(db):
            nxt = db.execute(
                "SELECT id FROM queue WHERE status='waiting' "
                "ORDER BY position ASC, id ASC LIMIT 1"
            ).fetchone()
            if nxt:
                db.execute("UPDATE queue SET status='playing' WHERE id=?",
                           (nxt["id"],))
        if current_playing(db):
            db.execute("UPDATE player_state SET status='playing' WHERE id=1")
    elif action == "pause":
        db.execute("UPDATE player_state SET status='paused' WHERE id=1")
    elif action == "next":
        advance(db)
    elif action == "stop":
        db.execute("UPDATE queue SET status='done' WHERE status='playing'")
        db.execute("UPDATE player_state SET status='stopped' WHERE id=1")
    elif action == "volume":
        try:
            vol = max(0.0, min(1.0, float(data.get("value", 1.0))))
        except (TypeError, ValueError):
            abort(400)
        db.execute("UPDATE player_state SET volume=? WHERE id=1", (vol,))
    elif action == "seek":
        try:
            seek_to = float(data.get("value", 0))
        except (TypeError, ValueError):
            abort(400)
        db.execute("UPDATE player_state SET seek_to=?, position=?, position_at=? "
                   "WHERE id=1", (seek_to, seek_to, time.time()))
    elif action == "restart":
        db.execute("UPDATE player_state SET seek_to=0, status='playing', "
                   "position=0, position_at=? WHERE id=1", (time.time(),))
    else:
        abort(400)

    db.execute("UPDATE player_state SET seq = seq + 1 WHERE id=1")
    db.commit()
    return jsonify(ok=True)


@app.route("/api/player/ended", methods=["POST"])
def api_player_ended():
    """Called by the player page when a song finishes naturally."""
    db = get_db()
    advance(db)
    db.execute("UPDATE player_state SET seq = seq + 1 WHERE id=1")
    db.commit()
    return jsonify(ok=True)


@app.route("/api/player/position", methods=["POST"])
def api_player_position():
    """The player page reports its current playback time so admin can show
    a live seek bar."""
    data = request.get_json(force=True)
    try:
        pos = float(data.get("position", 0))
        dur = float(data.get("duration", 0))
    except (TypeError, ValueError):
        abort(400)
    db = get_db()
    db.execute("UPDATE player_state SET position=?, duration=?, position_at=? WHERE id=1",
               (pos, dur, time.time()))
    db.commit()
    return jsonify(ok=True)


@app.route("/api/player/seeked", methods=["POST"])
def api_player_seeked():
    """The player acknowledges it has applied the pending seek target."""
    db = get_db()
    db.execute("UPDATE player_state SET seek_to=NULL WHERE id=1")
    db.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------
# Media streaming
# --------------------------------------------------------------------------
def _song_or_404(song_id):
    db = get_db()
    row = db.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
    if not row:
        abort(404)
    return row


@app.route("/media/<int:song_id>")
def media(song_id):
    row = _song_or_404(song_id)
    if not os.path.isfile(row["file_path"]):
        abort(404)
    return send_file(row["file_path"], conditional=True)


@app.route("/media/<int:song_id>/cdg")
def media_cdg(song_id):
    row = _song_or_404(song_id)
    if not row["cdg_path"] or not os.path.isfile(row["cdg_path"]):
        abort(404)
    return send_file(row["cdg_path"], mimetype="application/octet-stream",
                     conditional=True)


# --------------------------------------------------------------------------
# Utilities
# --------------------------------------------------------------------------
def local_ip():
    """Best-effort LAN IP for showing the connect URL."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------
if __name__ == "__main__":
    init_db()
    n = index_songs()
    ip = local_ip()
    print("=" * 60)
    print(" LAN Karaoke Server")
    print("=" * 60)
    print(f"  Songs indexed : {n}   (from {SONGS_DIR})")
    print(f"  Tablet (guests): http://{ip}:{PORT}/tablet")
    print(f"  Admin  (laptop): http://{ip}:{PORT}/admin")
    print(f"  Player (TV)    : http://{ip}:{PORT}/player")
    print("=" * 60)
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
