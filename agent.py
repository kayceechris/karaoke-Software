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

Run:  python agent.py
"""

import os
import socket

import requests
from flask import (Flask, jsonify, render_template, request, send_file,
                   abort, Response)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SONGS_DIR = os.environ.get("KARAOKE_SONGS_DIR", os.path.join(BASE_DIR, "songs"))
CLOUD_URL = os.environ.get("CLOUD_URL", "").rstrip("/")
HOST_TOKEN = os.environ.get("HOST_TOKEN", "")
AGENT_PORT = int(os.environ.get("AGENT_PORT", "5050"))

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
    return len(catalog)


# --------------------------------------------------------------------------
# Cloud proxy (browser talks only to the agent; agent talks to the cloud)
# --------------------------------------------------------------------------
def cloud_get(path):
    r = requests.get(f"{CLOUD_URL}{path}", timeout=15)
    return r.json()


def cloud_post(path, payload=None):
    r = requests.post(f"{CLOUD_URL}{path}", json=payload or {},
                      headers={"X-Host-Token": HOST_TOKEN}, timeout=15)
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
    if not CLOUD_URL:
        return jsonify(error="CLOUD_URL not set"), 503
    try:
        return jsonify(cloud_get("/api/player/state"))
    except requests.RequestException:
        return jsonify(status="stopped", current=None, volume=1.0, seq=0)


@app.route("/api/ended", methods=["POST"])
def api_ended():
    return jsonify(cloud_post("/api/player/ended"))


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


if __name__ == "__main__":
    print("=" * 60)
    print(" Karaoke Laptop Agent")
    print("=" * 60)
    n = push_catalog()
    ip = local_ip()
    print(f"  Songs found : {n}   (from {SONGS_DIR})")
    print(f"  Cloud       : {CLOUD_URL or '(CLOUD_URL not set)'}")
    print(f"  Player (TV) : http://{ip}:{AGENT_PORT}/player   <- open fullscreen")
    print("=" * 60)
    app.run(host="0.0.0.0", port=AGENT_PORT, threaded=True)
