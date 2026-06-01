"""
Karaoke song fetcher
====================

Downloads karaoke VIDEOS into the songs/ folder, named "Artist - Title.mp4"
so the karaoke app indexes them automatically.

  python fetch_songs.py "Queen Bohemian Rhapsody karaoke"
  python fetch_songs.py https://www.youtube.com/watch?v=XXXX
  python fetch_songs.py --file my_list.txt        # one query/URL per line

Each argument is either a direct video URL or a search phrase (the top
"ytsearch" result is taken). Files already present are skipped.

-----------------------------------------------------------------------------
  LEGAL / LICENSING — READ THIS
-----------------------------------------------------------------------------
Most commercial songs are copyrighted. Downloading and PUBLICLY PERFORMING
karaoke (a bar, hotel, lounge, event) requires the appropriate licences
(e.g. PRO/public-performance + any karaoke-track licence) REGARDLESS of where
the file came from. This tool does not grant any rights. Use it only for
content you are permitted to download and perform. You are responsible for
compliance in your country.
-----------------------------------------------------------------------------
"""

import os
import re
import sys

from yt_dlp import YoutubeDL

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SONGS_DIR = os.environ.get("KARAOKE_SONGS_DIR", os.path.join(BASE_DIR, "songs"))


def clean(s):
    """Make a string safe for a Windows filename."""
    s = re.sub(r'[<>:"/\\|?*]', "", s).strip()
    return re.sub(r"\s+", " ", s)


def derive_name(info):
    """Best-effort 'Artist - Title' from yt-dlp metadata."""
    artist = info.get("artist") or info.get("creator") or info.get("uploader") or ""
    track = info.get("track") or info.get("title") or "Unknown"
    title = clean(track)
    artist = clean(artist)
    # Strip noise so the app's "Artist - Title" parser stays clean.
    title = re.sub(r"(?i)\b(official|video|lyrics?|hd|4k)\b", "", title).strip(" -")
    if artist and " - " not in title:
        return f"{artist} - {title}"
    return title or "Unknown"


def fetch(query):
    os.makedirs(SONGS_DIR, exist_ok=True)
    target = query if re.match(r"^https?://", query) else f"ytsearch1:{query}"

    ydl_opts = {
        # Progressive mp4 (single file, no ffmpeg merge needed). Falls back to best mp4.
        "format": "best[ext=mp4][acodec!=none][vcodec!=none]/best[ext=mp4]/best",
        "outtmpl": os.path.join(SONGS_DIR, "%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }
    with YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(target, download=False)
        if "entries" in info:                       # search result
            if not info["entries"]:
                print(f"  [skip] no result for: {query}")
                return
            info = info["entries"][0]

        name = derive_name(info)
        final = os.path.join(SONGS_DIR, f"{name}.mp4")
        if os.path.exists(final):
            print(f"  [have] {name}.mp4")
            return

        print(f"  Downloading: {name}  ({info.get('webpage_url', target)})")
        ydl.params["outtmpl"]["default"] = os.path.join(SONGS_DIR, f"{name}.%(ext)s")
        ydl.download([info["webpage_url"]])
        print(f"  [done] {name}.mp4")


def main(argv):
    if not argv:
        print(__doc__)
        print("Usage: python fetch_songs.py \"<search or URL>\" [more...]")
        print("       python fetch_songs.py --file list.txt")
        return

    queries = []
    if argv[0] == "--file":
        with open(argv[1], encoding="utf-8") as f:
            queries = [ln.strip() for ln in f if ln.strip()
                       and not ln.startswith("#")]
    else:
        queries = argv

    print(f"Saving into: {SONGS_DIR}")
    for q in queries:
        try:
            fetch(q)
        except Exception as e:
            print(f"  [error] {q}: {e}")
    print("\nDone. Click 'Rescan songs' on Admin (offline) or restart the agent "
          "(hybrid) to pick up new files.")


if __name__ == "__main__":
    main(sys.argv[1:])
