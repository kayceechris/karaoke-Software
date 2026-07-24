"""
Karaoke LAPTOP agent  (runs on the laptop at the venue)
======================================================

The companion to the cloud brain (cloud_app.py on Render). It:

  1. Scans the local songs/ folder and UPLOADS the catalog (metadata only)
     to the cloud so guests can search it.
  2. Serves a local /player page (open this fullscreen on the TV).
  3. Plays the LOCAL media file for whatever the cloud says is "playing",
     proxying cloud state so the browser never needs the cloud URL or token.

Configure with environment variables (or a .env-style export):
  CLOUD_URL    e.g. https://your-app.onrender.com   (required)
  HOST_TOKEN   same secret you set on the cloud       (required if cloud has one)
  KARAOKE_SONGS_DIR   default ./songs
  AGENT_PORT          default 5050
  AUTO_LAUNCH_PLAYER  default on — opens /player itself, fullscreen, with
                      sound already unlocked. Set to 0 to disable.
  PLAYER_BROWSER_PATH optional override if Edge/Chrome auto-detection fails

Run:  python agent.py
"""

import os
import shutil
import socket
import subprocess
import threading
import webbrowser

import requests
from flask import (Flask, jsonify, render_template, request, send_file,
                   abort, Response)

import r2_storage

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SONGS_DIR = os.environ.get("KARAOKE_SONGS_DIR", os.path.join(BASE_DIR, "songs"))
CLOUD_URL = os.environ.get("CLOUD_URL", "").rstrip("/")
HOST_TOKEN = os.environ.get("HOST_TOKEN", "")
AGENT_PORT = int(os.environ.get("AGENT_PORT", "5050"))
AUTO_LAUNCH_PLAYER = os.environ.get("AUTO_LAUNCH_PLAYER", "1") not in ("0", "false", "False")

VIDEO_EXTS = {".mp4", ".webm", ".m4v"}
AUDIO_EXTS = {".mp3", ".m4a", ".ogg", ".wav"}

app = Flask(__name__)

# song_key -> {"path": abspath, "cdg": abspath|None, "kind": str}
LOCAL_MAP = {}


# --------------------------------------------------------------------------
# Library scanning
# --------------------------------------------------------------------------
def parse_name(basename):
    name = os.path.splitext(basename)[0]
    if " - " in name:
        a, t = name.split(" - ", 1)
        return a.strip(), t.strip()
    return "", name.strip()


def scan_songs():
    """Build LOCAL_MAP and return the catalog payload for the cloud."""
    LOCAL_MAP.clear()
    catalog = []
    os.makedirs(SONGS_DIR, exist_ok=True)
    for root, _dirs, files in os.walk(SONGS_DIR):
        lower = {f.lower(): f for f in files}
        for fname in files:
            ext = os.path.splitext(fname)[1].lower()
            full = os.path.join(root, fname)
            # stable key = path relative to songs dir, POSIX style
            key = os.path.relpath(full, SONGS_DIR).replace("\\", "/")
            artist, title = parse_name(fname)

            if ext in VIDEO_EXTS:
                kind, cdg = "video", None
            elif ext in AUDIO_EXTS:
                cdg_name = os.path.splitext(fname)[0] + ".cdg"
                cdg_real = lower.get(cdg_name.lower())
                cdg = os.path.join(root, cdg_real) if cdg_real else None
                kind = "cdg" if cdg else "audio"
            else:
                continue

            LOCAL_MAP[key] = {"path": full, "cdg": cdg, "kind": kind}
            catalog.append({"key": key, "title": title,
                            "artist": artist, "kind": kind})
    return catalog


def push_catalog():
    catalog = scan_songs()
    if not CLOUD_URL:
        print("  [warn] CLOUD_URL not set — running local-only, no catalog upload.")
        return len(catalog)
    try:
        r = requests.post(f"{CLOUD_URL}/api/catalog",
                          json={"songs": catalog},
                          headers={"X-Host-Token": HOST_TOKEN}, timeout=20)
        r.raise_for_status()
        print(f"  Uploaded {len(catalog)} songs to {CLOUD_URL}")
    except requests.RequestException as e:
        print(f"  [error] catalog upload failed: {e}")
    if r2_storage.ENABLED:
        threading.Thread(target=sync_media_to_r2, daemon=True).start()
    return len(catalog)


def fetch_queue_priority():
    """song_keys currently waiting/playing on the cloud, so the sync can jump
    the line for whatever's actually queued right now instead of grinding
    through the whole library in folder order first."""
    if not CLOUD_URL:
        return set()
    try:
        r = requests.get(f"{CLOUD_URL}/api/queue", timeout=4)
        r.raise_for_status()
        return {item["song_key"] for item in r.json()}
    except (requests.RequestException, ValueError, KeyError):
        return set()


def sync_media_to_r2():
    """Mirror local song files to R2 so the cloud /tablet can stream them
    directly to guests. Runs in a background thread — safe to re-run (skips
    files already uploaded), so it's called on every startup/resync and only
    does real work for songs that are new since the last sync.

    Currently-queued songs upload first; priority is re-checked every few
    files so a song queued mid-sync jumps ahead of the rest of a large
    library instead of waiting behind it."""
    remaining = list(LOCAL_MAP.items())
    uploaded = skipped = failed = 0
    priority = fetch_queue_priority()
    since_refresh = 0

    while remaining:
        if since_refresh >= 5:
            priority = fetch_queue_priority()
            since_refresh = 0
        if priority:
            remaining.sort(key=lambda kv: kv[0] not in priority)
        key, entry = remaining.pop(0)
        since_refresh += 1

        try:
            if r2_storage.object_exists(key):
                skipped += 1
            else:
                r2_storage.upload_file(key, entry["path"])
                uploaded += 1
                print(f"  [r2] uploaded {key}")
        except Exception as e:
            failed += 1
            print(f"  [r2] failed to upload {key}: {e}")

        if entry["cdg"]:
            cdg_key = os.path.splitext(key)[0] + ".cdg"
            try:
                if r2_storage.object_exists(cdg_key):
                    skipped += 1
                else:
                    r2_storage.upload_file(cdg_key, entry["cdg"])
                    uploaded += 1
                    print(f"  [r2] uploaded {cdg_key}")
            except Exception as e:
                failed += 1
                print(f"  [r2] failed to upload {cdg_key}: {e}")
    print(f"  [r2] sync done — {uploaded} uploaded, {skipped} already present, "
          f"{failed} failed")


# --------------------------------------------------------------------------
# Cloud proxy (browser talks only to the agent; agent talks to the cloud)
# --------------------------------------------------------------------------
def cloud_get(path):
    r = requests.get(f"{CLOUD_URL}{path}", timeout=4)
    return r.json()


def cloud_post(path, payload=None):
    r = requests.post(f"{CLOUD_URL}{path}", json=payload or {},
                      headers={"X-Host-Token": HOST_TOKEN}, timeout=4)
    return r.json()


@app.route("/")
def home():
    return render_template("agent_home.html", ip=local_ip(), port=AGENT_PORT,
                           cloud=CLOUD_URL or "(not set)")


@app.route("/player")
def player():
    return render_template("player_hybrid.html")


@app.route("/api/state")
def api_state():
    # NOTE: never report current=None on error — the player would treat the next
    # successful poll as a new song and restart it from 0:00. Signal "unavailable"
    # instead so the player simply skips that tick and keeps playing.
    if not CLOUD_URL:
        return jsonify(unavailable=True), 200
    try:
        return jsonify(cloud_get("/api/player/state"))
    except requests.RequestException:
        return jsonify(unavailable=True), 200


@app.route("/api/ended", methods=["POST"])
def api_ended():
    return jsonify(cloud_post("/api/player/ended"))


@app.route("/api/position", methods=["POST"])
def api_position():
    return jsonify(cloud_post("/api/player/position", request.get_json(force=True)))


@app.route("/api/seeked", methods=["POST"])
def api_seeked():
    return jsonify(cloud_post("/api/player/seeked"))


@app.route("/api/resync", methods=["POST"])
def api_resync():
    return jsonify(ok=True, count=push_catalog())


# --------------------------------------------------------------------------
# Local media streaming (only the laptop can read these files)
# --------------------------------------------------------------------------
@app.route("/local-media/<path:key>")
def local_media(key):
    entry = LOCAL_MAP.get(key)
    if not entry:
        abort(404)
    if request.args.get("cdg"):
        if not entry["cdg"] or not os.path.isfile(entry["cdg"]):
            abort(404)
        return send_file(entry["cdg"], mimetype="application/octet-stream",
                         conditional=True)
    if not os.path.isfile(entry["path"]):
        abort(404)
    return send_file(entry["path"], conditional=True)


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


# --------------------------------------------------------------------------
# Auto-launch the player (so sound comes out without anyone manually
# opening a browser tab and clicking it — browsers otherwise block
# autoplay-with-sound until a real user gesture)
# --------------------------------------------------------------------------
def _find_chromium():
    """Edge ships with Windows, so try it first; fall back to Chrome."""
    candidates = [
        os.environ.get("PLAYER_BROWSER_PATH"),
        shutil.which("msedge"),
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        shutil.which("chrome"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    return next((p for p in candidates if p and os.path.isfile(p)), None)


def launch_player():
    """Open the TV player fullscreen with sound already unlocked. Falls back
    to the system default browser (still needs one manual click to unlock
    sound) if no Chromium-based browser is found."""
    browser = _find_chromium()
    if not browser:
        print("  [warn] No Edge/Chrome found — opening player in your default "
              "browser (click it once to unlock sound).")
        webbrowser.open(f"http://127.0.0.1:{AGENT_PORT}/player")
        return
    url = f"http://127.0.0.1:{AGENT_PORT}/player?autoplay=1"
    # --autoplay-policy (and most other flags) only take effect when this is
    # the first process of the browser to start — if Edge/Chrome is already
    # running for anything else, a plain launch just opens a new window in
    # that existing process and silently ignores the flag, so sound would
    # still need a real click. A dedicated profile dir forces a genuinely
    # separate instance where the flag actually applies.
    profile_dir = os.path.join(BASE_DIR, ".player-profile")
    subprocess.Popen([
        browser, f"--app={url}",
        "--autoplay-policy=no-user-gesture-required",
        "--start-fullscreen", "--new-window",
        f"--user-data-dir={profile_dir}",
        "--no-first-run", "--no-default-browser-check",
    ])


if __name__ == "__main__":
    print("=" * 60)
    print(" Karaoke Laptop Agent")
    print("=" * 60)
    n = push_catalog()
    ip = local_ip()
    print(f"  Songs found : {n}   (from {SONGS_DIR})")
    print(f"  Cloud       : {CLOUD_URL or '(CLOUD_URL not set)'}")
    print(f"  R2 media    : {'syncing in background' if r2_storage.ENABLED else '(not configured — cloud /tablet has no video)'}")
    print(f"  Player (TV) : http://{ip}:{AGENT_PORT}/player"
          + ("   <- launching automatically" if AUTO_LAUNCH_PLAYER
             else "   <- open fullscreen"))
    print("=" * 60)
    if AUTO_LAUNCH_PLAYER:
        threading.Timer(1.5, launch_player).start()
    app.run(host="0.0.0.0", port=AGENT_PORT, threaded=True)
