"""
Karaoke CLOUD brain  (deploy this to Render)
============================================

Hosts the parts that need to be reachable over the internet:
  - /tablet   guests search + request songs from their phones (open)
  - /admin    host controls playback from anywhere (needs HOST_TOKEN)
  - queue + player-state API
  - song CATALOG (metadata only — NO media files live here)

Your laptop runs agent.py, which:
  - uploads its song catalog here (POST /api/catalog)
  - polls /api/player/state and plays the matching LOCAL file on the TV
  - reports song endings (POST /api/player/ended)

Env vars:
  DATABASE_URL  Postgres URL (Render provides it). Unset -> local SQLite.
  HOST_TOKEN    shared secret for admin + agent. Unset -> auth disabled (dev).
"""

import io
import os
import re
from functools import wraps
from urllib.parse import quote

import qrcode
import qrcode.image.svg
import requests
from flask import (Flask, jsonify, render_template, request, abort, send_file,
                   Response, redirect)

import db

HOST_TOKEN = os.environ.get("HOST_TOKEN", "")
R2_PUBLIC_BASE_URL = os.environ.get("R2_PUBLIC_BASE_URL", "").rstrip("/")
LRCLIB_UA = "MelbourneKaraoke/1.0 (+https://karaoke-t33m.onrender.com)"
_LYRICS_CACHE = {}  # song_id -> result dict (lyrics don't change during an event)

app = Flask(__name__)
db.init_schema()


# --------------------------------------------------------------------------
# Auth: host-only endpoints require the shared token (header or ?key=)
# --------------------------------------------------------------------------
def host_ok():
    if not HOST_TOKEN:
        return True  # dev mode, no token configured
    supplied = request.headers.get("X-Host-Token") or request.args.get("key")
    return supplied == HOST_TOKEN


def require_host(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if not host_ok():
            abort(401)
        return fn(*a, **kw)
    return wrapper


# --------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------
@app.route("/")
def home():
    return render_template("cloud_home.html",
                           public_url=request.url_root.rstrip("/"))


@app.route("/tablet")
def tablet():
    return render_template("tablet.html")


@app.route("/admin")
def admin():
    return render_template("admin.html", auth=bool(HOST_TOKEN))


@app.route("/player")
def player_info():
    # The real player runs on the laptop agent; the cloud can't play local files.
    return render_template("cloud_player_info.html")


# ---- PWA: serve service worker + manifest from root scope ----
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


# ---- QR code: printable poster guests scan to open /tablet ----
def _tablet_url():
    # Render terminates TLS upstream, so trust the forwarded scheme for https.
    scheme = request.headers.get("X-Forwarded-Proto", request.scheme)
    return f"{scheme}://{request.host}/tablet"


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


# --------------------------------------------------------------------------
# Catalog (host/agent only): laptop pushes its song list here
# --------------------------------------------------------------------------
@app.route("/api/catalog", methods=["POST"])
@require_host
def api_catalog():
    data = request.get_json(force=True)
    songs = data.get("songs", [])
    with db.transaction() as cur:
        keys = []
        for s in songs:
            key = (s.get("key") or "").strip()
            if not key:
                continue
            keys.append(key)
            db.x(cur,
                 "INSERT INTO songs (song_key, title, artist, kind) "
                 "VALUES (?,?,?,?) "
                 "ON CONFLICT (song_key) DO UPDATE SET "
                 "title=EXCLUDED.title, artist=EXCLUDED.artist, kind=EXCLUDED.kind",
                 (key, s.get("title", key), s.get("artist", ""),
                  s.get("kind", "video")))
        # Drop songs no longer present locally (unless queued).
        if keys:
            ph = ",".join(["?"] * len(keys))
            db.x(cur,
                 f"DELETE FROM songs WHERE song_key NOT IN ({ph}) "
                 f"AND id NOT IN (SELECT song_id FROM queue "
                 f"WHERE status IN ('waiting','playing'))", keys)
    return jsonify(ok=True, count=len(keys))


# --------------------------------------------------------------------------
# Song search (open to guests)
# --------------------------------------------------------------------------
@app.route("/api/songs")
def api_songs():
    q = request.args.get("q", "").strip()
    if q:
        # LOWER() both sides so search is case-insensitive on Postgres too
        # (Postgres LIKE is case-sensitive; SQLite's is not).
        like = f"%{q.lower()}%"
        rows = db.fetchall(
            "SELECT id, song_key, title, artist, kind FROM songs "
            "WHERE LOWER(title) LIKE ? OR LOWER(artist) LIKE ? "
            "ORDER BY artist, title LIMIT 200",
            (like, like))
    else:
        rows = db.fetchall(
            "SELECT id, song_key, title, artist, kind FROM songs "
            "ORDER BY artist, title LIMIT 200")
    return jsonify(rows)


# --------------------------------------------------------------------------
# Media (open to guests) — redirects to the song's public R2 URL. The agent
# uploads files to R2 ahead of time; the cloud never stores or proxies bytes.
# --------------------------------------------------------------------------
@app.route("/media/<int:song_id>")
def media(song_id):
    if not R2_PUBLIC_BASE_URL:
        abort(404)
    row = db.fetchone("SELECT song_key FROM songs WHERE id=?", (song_id,))
    if not row:
        abort(404)
    return redirect(f"{R2_PUBLIC_BASE_URL}/{quote(row['song_key'], safe='/')}")


@app.route("/media/<int:song_id>/cdg")
def media_cdg(song_id):
    if not R2_PUBLIC_BASE_URL:
        abort(404)
    row = db.fetchone("SELECT song_key, kind FROM songs WHERE id=?", (song_id,))
    if not row or row["kind"] != "cdg":
        abort(404)
    cdg_key = os.path.splitext(row["song_key"])[0] + ".cdg"
    return redirect(f"{R2_PUBLIC_BASE_URL}/{quote(cdg_key, safe='/')}")


# --------------------------------------------------------------------------
# Lyrics (open to guests) — fetched from LRCLIB by title/artist
# --------------------------------------------------------------------------
_NOISE = re.compile(
    r"(?i)\b(karaoke|version|instrumental|lyrics?|official|video|audio|hd|4k|"
    r"karafun|djpsalmy|mcpsalmy|psalmy|remake|cover|remix|male key|female key|higher key|"
    r"lower key|with backing vocals|no backing vocals|backing vocals|"
    r"in the style of|made famous by)\b")

# Strip "ft. Artist", "feat. Artist", "featuring Artist" suffix from titles
_FEAT_RE = re.compile(r"(?i)\s+(?:ft\.?|feat\.?|featuring)\s+.+$")

# Artist fields that are karaoke publisher labels, not real artists
_KARAOKE_LABEL = re.compile(
    r"(?i)\b(karaoke|studio|gap|karafun|djpsalmy|mcpsalmy|psalmy|backing|instrumental)\b")

# Title field contains "karaoke" → the filename was stored Song-first, Artist-last
_KARAOKE_IN_TITLE = re.compile(r"(?i)\bkaraoke\b")


def _clean_meta(s):
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s or "")   # drop (...) and [...]
    s = _FEAT_RE.sub("", s)                          # drop "ft./feat. ..." suffix
    s = _NOISE.sub(" ", s)
    s = re.sub(r"[^A-Za-z0-9\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _real_artist_title(raw_title, raw_artist):
    """Recover real artist + title from karaoke file metadata.

    Case 1 – stored artist is a publisher label AND title embeds "Artist - Title":
      e.g. artist="Gap Karaoke", title="Asake -Terminator (Karaoke Version)"
      → title="Terminator", artist="Asake"

    Case 2 – title contains the word 'karaoke' (file was named "Song - Artist karaoke"):
      e.g. title="R. Kelly karaoke", artist="Ignition (Remix)"
      → swap: title="Ignition (Remix)", artist="R. Kelly karaoke"
         _clean_meta then strips 'karaoke' leaving artist="R Kelly"
    """
    if not raw_artist or _KARAOKE_LABEL.search(raw_artist):
        base = re.sub(r"\(.*?\)|\[.*?\]", " ", raw_title or "").strip()
        m = re.match(r"^(.+?)\s+-\s*(.+)$", base)
        if m:
            # group(1)=Artist portion, group(2)=Title portion → return (title, artist)
            return m.group(2).strip(), m.group(1).strip()

    if _KARAOKE_IN_TITLE.search(raw_title or ""):
        # File named "Song - Artist karaoke": stored title is really the artist label,
        # stored artist is really the song title — swap them.
        return raw_artist, raw_title

    return raw_title, raw_artist


def _lrclib_result(d):
    return {
        "found": True,
        "plain": d["plainLyrics"],
        "synced": d.get("syncedLyrics") or "",
        "name": f"{d.get('artistName', '')} — {d.get('trackName', '')}".strip(" —"),
        "source": "LRCLIB",
    }


@app.route("/api/lyrics")
def api_lyrics():
    song_id = request.args.get("song_id", type=int)
    if song_id is None:
        abort(400)
    if song_id in _LYRICS_CACHE:
        return jsonify(_LYRICS_CACHE[song_id])

    row = db.fetchone("SELECT title, artist FROM songs WHERE id=?", (song_id,))
    if not row:
        abort(404)

    raw_title, raw_artist = _real_artist_title(row["title"], row["artist"])
    title = _clean_meta(raw_title)
    artist = _clean_meta(raw_artist)
    result = {"found": False}
    cacheable = True  # don't cache a transient network failure as "not found"

    if title:
        try:
            # Strategy 1: exact lookup by track + artist (most accurate)
            params1 = {"track_name": title}
            if artist:
                params1["artist_name"] = artist
            r = requests.get("https://lrclib.net/api/get",
                             params=params1,
                             headers={"User-Agent": LRCLIB_UA}, timeout=12)
            if r.status_code == 200:
                d = r.json()
                if d.get("plainLyrics"):
                    result = _lrclib_result(d)

            # Strategy 2: structured search with separate track/artist params
            if not result["found"]:
                params2 = {"track_name": title}
                if artist:
                    params2["artist_name"] = artist
                r = requests.get("https://lrclib.net/api/search",
                                 params=params2,
                                 headers={"User-Agent": LRCLIB_UA}, timeout=12)
                if r.ok:
                    best = next((d for d in r.json() if d.get("plainLyrics")), None)
                    if best:
                        result = _lrclib_result(best)

            # Strategy 3: fallback combined free-text query
            if not result["found"]:
                query = (artist + " " + title).strip()
                r = requests.get("https://lrclib.net/api/search",
                                 params={"q": query},
                                 headers={"User-Agent": LRCLIB_UA}, timeout=12)
                if r.ok:
                    best = next((d for d in r.json() if d.get("plainLyrics")), None)
                    if best:
                        result = _lrclib_result(best)

            # Strategy 4: title-only search (catches artist name mismatches)
            if not result["found"] and title:
                r = requests.get("https://lrclib.net/api/search",
                                 params={"track_name": title},
                                 headers={"User-Agent": LRCLIB_UA}, timeout=12)
                if r.ok:
                    best = next((d for d in r.json() if d.get("plainLyrics")), None)
                    if best:
                        result = _lrclib_result(best)

        except requests.RequestException:
            cacheable = False  # network hiccup — allow a retry on the next request

    if cacheable:
        _LYRICS_CACHE[song_id] = result
    return jsonify(result)


# --------------------------------------------------------------------------
# Queue
# --------------------------------------------------------------------------
def queue_rows():
    return db.fetchall(
        """
        SELECT q.id, q.singer, q.status, q.position,
               s.id AS song_id, s.song_key, s.title, s.artist, s.kind
        FROM queue q JOIN songs s ON s.id = q.song_id
        WHERE q.status IN ('waiting','playing')
        ORDER BY (q.status='playing') DESC, q.position ASC, q.id ASC
        """)


@app.route("/api/queue")
def api_queue():
    return jsonify(queue_rows())


@app.route("/api/queue", methods=["POST"])
def api_queue_add():
    data = request.get_json(force=True)
    song_id = data.get("song_id")
    singer = (data.get("singer") or "Guest").strip()[:40] or "Guest"
    if not db.fetchone("SELECT 1 AS ok FROM songs WHERE id=?", (song_id,)):
        abort(404)
    nextpos = db.fetchone(
        "SELECT COALESCE(MAX(position),0)+1 AS p FROM queue WHERE status='waiting'"
    )["p"]
    db.execute("INSERT INTO queue (song_id, singer, position) VALUES (?,?,?)",
               (song_id, singer, nextpos))
    return jsonify(ok=True)


@app.route("/api/queue/<int:qid>", methods=["DELETE"])
@require_host
def api_queue_remove(qid):
    db.execute("DELETE FROM queue WHERE id=?", (qid,))
    return jsonify(ok=True)


@app.route("/api/queue/<int:qid>/top", methods=["POST"])
@require_host
def api_queue_top(qid):
    minpos = db.fetchone(
        "SELECT COALESCE(MIN(position),1) AS p FROM queue WHERE status='waiting'"
    )["p"]
    db.execute("UPDATE queue SET position=? WHERE id=? AND status='waiting'",
               (minpos - 1, qid))
    return jsonify(ok=True)


@app.route("/api/queue/<int:qid>/move", methods=["POST"])
@require_host
def api_queue_move(qid):
    """Swap a waiting item with its immediate neighbor (direction: up/down)."""
    data = request.get_json(force=True)
    direction = data.get("direction")
    if direction not in ("up", "down"):
        abort(400)
    rows = db.fetchall(
        "SELECT id, position FROM queue WHERE status='waiting' "
        "ORDER BY position ASC, id ASC")
    ids = [r["id"] for r in rows]
    if qid not in ids:
        abort(404)
    idx = ids.index(qid)
    swap_idx = idx - 1 if direction == "up" else idx + 1
    if 0 <= swap_idx < len(ids):
        a, b = rows[idx], rows[swap_idx]
        with db.transaction() as cur:
            db.x(cur, "UPDATE queue SET position=? WHERE id=?", (b["position"], a["id"]))
            db.x(cur, "UPDATE queue SET position=? WHERE id=?", (a["position"], b["id"]))
    return jsonify(ok=True)


# --------------------------------------------------------------------------
# Player state + control
# --------------------------------------------------------------------------
def current_playing(cur=None):
    sql = """
        SELECT q.id AS queue_id, q.singer,
               s.id AS song_id, s.song_key, s.title, s.artist, s.kind
        FROM queue q JOIN songs s ON s.id = q.song_id
        WHERE q.status='playing' LIMIT 1
    """
    if cur is not None:
        db.x(cur, sql)
        r = cur.fetchone()
        return dict(r) if r else None
    return db.fetchone(sql)


def _advance(cur):
    db.x(cur, "UPDATE queue SET status='done' WHERE status='playing'")
    db.x(cur, "SELECT id FROM queue WHERE status='waiting' "
              "ORDER BY position ASC, id ASC LIMIT 1")
    nxt = cur.fetchone()
    if nxt:
        db.x(cur, "UPDATE queue SET status='playing' WHERE id=?", (nxt["id"],))
        db.x(cur, "UPDATE player_state SET status='playing', seek_to=NULL, "
                  "position=0, duration=0 WHERE id=1")
    else:
        db.x(cur, "UPDATE player_state SET status='stopped', seek_to=NULL, "
                  "position=0, duration=0 WHERE id=1")


@app.route("/api/player/state")
def api_player_state():
    st = db.fetchone(
        "SELECT status, volume, seq, position, duration, seek_to FROM player_state WHERE id=1")
    cur = current_playing()
    return jsonify(status=st["status"], volume=st["volume"], seq=st["seq"],
                   position=st.get("position") or 0,
                   duration=st.get("duration") or 0,
                   seek_to=st.get("seek_to"),
                   current=cur)


@app.route("/api/player/command", methods=["POST"])
@require_host
def api_player_command():
    data = request.get_json(force=True)
    action = data.get("action")
    value = data.get("value", 1.0)
    with db.transaction() as cur:
        if action == "play":
            if not current_playing(cur):
                db.x(cur, "SELECT id FROM queue WHERE status='waiting' "
                          "ORDER BY position ASC, id ASC LIMIT 1")
                nxt = cur.fetchone()
                if nxt:
                    db.x(cur, "UPDATE queue SET status='playing' WHERE id=?",
                         (nxt["id"],))
            if current_playing(cur):
                db.x(cur, "UPDATE player_state SET status='playing' WHERE id=1")
        elif action == "pause":
            db.x(cur, "UPDATE player_state SET status='paused' WHERE id=1")
        elif action == "next":
            _advance(cur)
        elif action == "stop":
            db.x(cur, "UPDATE queue SET status='done' WHERE status='playing'")
            db.x(cur, "UPDATE player_state SET status='stopped' WHERE id=1")
        elif action == "volume":
            try:
                vol = max(0.0, min(1.0, float(value)))
            except (TypeError, ValueError):
                abort(400)
            db.x(cur, "UPDATE player_state SET volume=? WHERE id=1", (vol,))
        elif action == "seek":
            try:
                seek_to = float(value)
            except (TypeError, ValueError):
                abort(400)
            db.x(cur, "UPDATE player_state SET seek_to=? WHERE id=1", (seek_to,))
        elif action == "restart":
            db.x(cur, "UPDATE player_state SET seek_to=0, status='playing' WHERE id=1")
        else:
            abort(400)
        db.x(cur, "UPDATE player_state SET seq = seq + 1 WHERE id=1")
    return jsonify(ok=True)


@app.route("/api/player/ended", methods=["POST"])
@require_host
def api_player_ended():
    with db.transaction() as cur:
        _advance(cur)
        db.x(cur, "UPDATE player_state SET seq = seq + 1, position=0, duration=0 WHERE id=1")
    return jsonify(ok=True)


@app.route("/api/player/position", methods=["POST"])
@require_host
def api_player_position():
    data = request.get_json(force=True)
    pos = float(data.get("position", 0))
    dur = float(data.get("duration", 0))
    db.execute("UPDATE player_state SET position=?, duration=? WHERE id=1", (pos, dur))
    return jsonify(ok=True)


@app.route("/api/player/seeked", methods=["POST"])
@require_host
def api_player_seeked():
    db.execute("UPDATE player_state SET seek_to=NULL WHERE id=1")
    return jsonify(ok=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    app.run(host="0.0.0.0", port=port)
