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

### Optional: a second admin tier for staff (no player control)

Set `STAFF_TOKEN` on Render (Environment tab, same as `HOST_TOKEN`) to hand
out a second `/admin` login for other staff: they can view the queue,
drag-reorder it, and delete songs, but the transport controls (play,
pause, next, stop, restart, volume, seek) stay hidden and are rejected
server-side even if called directly — only `HOST_TOKEN` can touch those.
Leave unset to skip this entirely.

### Optional: a "watch" link/QR on the cloud tablet

`/tablet` is text-only (title/singer, no video) — the real picture and sound
belong on the laptop's own player, driven straight off local files. If you
want guests to be able to open that same player (muted — the host instance
is the only one with real sound) from their own phone while on the venue
Wi‑Fi, point the cloud at it:

1. Start the agent and note the URL it prints, e.g. `http://192.168.1.23:5050/player`.
2. On **Render**, open the service → **Environment** → add `LOCAL_PLAYER_URL`
   set to that exact URL. (It's a private LAN address — the cloud can't
   discover it on its own, and it'll change if the laptop joins a different
   network, so update this each event if needed.)
3. `/tablet` now shows a **📺 Cloud Player** button next to Install, and
   `/qr-player` gives you a printable "scan to watch" poster — both open the
   laptop's player directly. Only works for guests on the same Wi‑Fi as the
   laptop; leave `LOCAL_PLAYER_URL` unset to hide both.

### Optional: mirror songs to Cloudflare R2

`agent.py` can also mirror your song files to Cloudflare R2 in the
background (free tier: 10GB storage, zero egress fees) via `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and
`R2_PUBLIC_BASE_URL` (set on both the laptop and Render — see
[r2_storage.py](r2_storage.py)). Nothing in the current UI serves video from
it, but `cloud_app.py`'s `/media/<id>` still redirects there if you build
something that needs it. Leave unset to skip entirely.

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
| [cloud_app.py](cloud_app.py) | Cloud brain — queue, /tablet, /admin, catalog API, /media redirects (deploy this) |
| [agent.py](agent.py) | Laptop agent — uploads catalog, serves /player, plays local files, syncs media to R2 |
| [app.py](app.py) | All‑in‑one offline LAN server |
| [db.py](db.py) | DB adapter (SQLite local / Postgres on Render) |
| [r2_storage.py](r2_storage.py) | Cloudflare R2 client (agent-only) so cloud guests get real video |
| [fetch_songs.py](fetch_songs.py) | Karaoke downloader |
| [render.yaml](render.yaml) / [vercel.json](vercel.json) / [Procfile](Procfile) | Deploy configs |
| [start.bat](start.bat) / [start_agent.bat](start_agent.bat) | Windows launchers |

## Environment variables

| Var | Used by | Meaning |
|-----|---------|---------|
| `DATABASE_URL` | cloud | Postgres URL (Render sets it). Unset → local SQLite |
| `HOST_TOKEN` | cloud + agent | Shared secret for full admin control + catalog. Unset → auth off (dev only) |
| `STAFF_TOKEN` | cloud | Optional second admin login: queue view/reorder/delete only, no player transport. Unset → no staff tier |
| `CLOUD_URL` | agent | URL of the deployed cloud brain |
| `KARAOKE_SONGS_DIR` | agent / offline | Songs folder (default `./songs`) |
| `AGENT_PORT` / `KARAOKE_PORT` | agent / offline | Local port (5050 / 5000) |
| `LOCAL_PLAYER_URL` | cloud | The agent's LAN player URL (e.g. `http://192.168.1.23:5050/player`), printed at agent startup. Unset → no Cloud Player button/QR on `/tablet` |
| `R2_PUBLIC_BASE_URL` | cloud + agent | Public R2 bucket URL. Cloud uses it for `/media` redirects (unused by the current UI); agent uses it to check which files are already uploaded |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | agent | Credentials the agent uses to mirror songs to R2. All optional — unset skips media sync entirely |

## Troubleshooting

- **Guests can't reach `/tablet` (hybrid):** that's just your public Render URL — works on
  any network. If it's slow to first load, Render's free tier sleeps when idle (~30s wake).
- **Player shows "Ready" but nothing plays:** click the player page once (browsers block
  autoplay until a user gesture); confirm the agent window shows your songs uploaded.
- **Guest can't reach `/tablet` (offline LAN):** same Wi‑Fi; allow Python through Windows
  Firewall (Private); use the IP printed in the console.
- **No lyrics on an `.mp3`:** it needs a matching `.cdg` file with the same name.
