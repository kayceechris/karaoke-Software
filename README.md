# 🎤 Karaoke System

A laptop-powered karaoke system with two ways to run it:

- **Offline LAN mode** — everything on the laptop; guests use it over local Wi‑Fi.
- **Hybrid cloud mode** — guests order over the **internet** (hosted on Render/Vercel),
  while songs stay on the laptop and play locally. **(your chosen setup)**

```
HYBRID:  Guest phone (internet) ─► Render (queue + /tablet + /admin, Postgres)
                                        ▲ uploads catalog   │ "what's playing?"
                                        │                   ▼
                              Laptop agent.py plays the LOCAL file ─► TV
```

The cloud never stores media — only the song list (titles/artists). Your laptop
runs **`agent.py`**, which registers its songs to the cloud and plays the matching
local file on the TV.

---

## A. Hybrid cloud mode (Render + laptop agent)

### Step 1 — Deploy the cloud brain to Render
1. Push this folder to a GitHub repo.
2. Render → **New + → Blueprint** → pick the repo. [render.yaml](render.yaml) provisions
   a free web service **and** a free Postgres database, and auto-generates a `HOST_TOKEN`.
3. After deploy, open the service → **Environment** tab → copy:
   - your URL, e.g. `https://karaoke-xxxx.onrender.com`
   - the generated **`HOST_TOKEN`** value

> Deploying to **Vercel** instead? Use [vercel.json](vercel.json). Vercel has **no database**,
> so create a free Postgres (Neon/Supabase) and set `DATABASE_URL` + `HOST_TOKEN` in the
> Vercel project's Environment settings. *(Render is the smoother path — it includes the DB.)*

### Step 2 — Run the agent on the laptop
1. Edit [start_agent.bat](start_agent.bat) and paste your `CLOUD_URL` and `HOST_TOKEN`.
2. Double‑click **`start_agent.bat`**. It uploads your song list and starts the player.
3. Open the printed player URL (e.g. `http://192.168.x.x:5050/player`) **fullscreen on the TV**
   and click once to enable playback.

### Step 3 — Use it
- **Guests:** share `https://<your-cloud-url>/tablet` (great as a QR code on tables).
- **Host:** open `https://<your-cloud-url>/admin`, enter the `HOST_TOKEN` once, control playback.
- Add/remove song files on the laptop, then restart the agent (or `POST /api/resync`) to refresh.

---

## B. Offline LAN mode (no internet, single laptop)

Everything in one process — simplest for a home party.

1. Put songs in [songs/](songs/).
2. Double‑click **`start.bat`**.
3. On the laptop open `/player` (drag to TV) and `/admin`; guests on the same Wi‑Fi
   open the printed `/tablet` URL.

Runs from [app.py](app.py). Uses its own `karaoke.db` (separate from cloud mode).

---

## Getting songs into the folder

Name files **`Artist - Title.ext`** so artist/title fill in automatically.

| Format | Result |
|--------|--------|
| `Artist - Title.mp4` | video karaoke |
| `Artist - Title.mp3` + `Artist - Title.cdg` | classic MP3+G (lyrics drawn on TV) |
| `Artist - Title.mp3` | audio only |

### Downloader: `fetch_songs.py`
```
pip install yt-dlp
python fetch_songs.py "Queen Bohemian Rhapsody karaoke"
python fetch_songs.py https://www.youtube.com/watch?v=XXXX
python fetch_songs.py --file my_list.txt
```
Downloads karaoke videos as `Artist - Title.mp4` into `songs/`. Re-run the agent
(hybrid) or click **Rescan songs** (offline) afterwards.

> ⚠️ **Licensing:** most songs are copyrighted. Publicly performing karaoke at a
> **bar/hotel/lounge/event requires the proper licences** (public-performance +
> karaoke-track rights) no matter where the file came from. This tool grants no
> rights — only download/perform content you're permitted to. You're responsible
> for compliance.

---

## Files

| File | Role |
|------|------|
| [cloud_app.py](cloud_app.py) | Cloud brain — queue, /tablet, /admin, catalog API (deploy this) |
| [agent.py](agent.py) | Laptop agent — uploads catalog, serves /player, plays local files |
| [app.py](app.py) | All‑in‑one offline LAN server |
| [db.py](db.py) | DB adapter (SQLite local / Postgres on Render) |
| [fetch_songs.py](fetch_songs.py) | Karaoke downloader |
| [render.yaml](render.yaml) / [vercel.json](vercel.json) / [Procfile](Procfile) | Deploy configs |
| [start.bat](start.bat) / [start_agent.bat](start_agent.bat) | Windows launchers |

## Environment variables

| Var | Used by | Meaning |
|-----|---------|---------|
| `DATABASE_URL` | cloud | Postgres URL (Render sets it). Unset → local SQLite |
| `HOST_TOKEN` | cloud + agent | Shared secret for admin + catalog/control. Unset → auth off (dev only) |
| `CLOUD_URL` | agent | URL of the deployed cloud brain |
| `KARAOKE_SONGS_DIR` | agent / offline | Songs folder (default `./songs`) |
| `AGENT_PORT` / `KARAOKE_PORT` | agent / offline | Local port (5050 / 5000) |

## Troubleshooting

- **Guests can't reach `/tablet` (hybrid):** that's just your public Render URL — works on
  any network. If it's slow to first load, Render's free tier sleeps when idle (~30s wake).
- **Player shows "Ready" but nothing plays:** click the player page once (browsers block
  autoplay until a user gesture); confirm the agent window shows your songs uploaded.
- **Guest can't reach `/tablet` (offline LAN):** same Wi‑Fi; allow Python through Windows
  Firewall (Private); use the IP printed in the console.
- **No lyrics on an `.mp3`:** it needs a matching `.cdg` file with the same name.
