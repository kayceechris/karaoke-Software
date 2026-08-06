// Guest-facing player for CLOUD mode. Runs on karaoke-t33m.onrender.com
// itself, reachable by anyone on or off the venue Wi-Fi — unlike
// player_agent.js (the LAN player on the laptop agent), this page is never
// the authoritative source: it only ever watches and never writes back.
//   GET /api/player/state       -> same state admin.js already polls
//   GET /media/<song_id>        -> redirects to the song's public R2 URL
//   GET /media/<song_id>/cdg    -> redirects to the .cdg's public R2 URL
const video = document.getElementById("video");
const audio = document.getElementById("audio");
const canvas = document.getElementById("cdg");
const idle = document.getElementById("idle");
const overlay = document.getElementById("overlay");
const titleEl = document.getElementById("title");
const singerEl = document.getElementById("singer");

const cdg = new CDGPlayer(canvas);

let unlocked = false;
let currentQueueId = null;
let currentKind = null;
let volume = 1.0;
let cdgActive = false;
let songEnded = false;
let lastCorrectionAt = 0;
// How far ahead of the host's reported position this player targets, to
// cancel out R2 fetch/decode latency (see loadSong/poll below).
const LEAD_SECONDS = 1;

// This player is always muted — it's a silent visual mirror for guests off
// the venue Wi-Fi, never a second audio source. Muted playback is allowed
// unconditionally by every browser, so it autoplays immediately, no tap
// required.
video.muted = true;
audio.muted = true;

function activeMedia() { return currentKind === "video" ? video : audio; }

async function unlock() {
  unlocked = true;
  try { await video.play().catch(() => {}); video.pause(); } catch (e) {}
  try { await audio.play().catch(() => {}); audio.pause(); } catch (e) {}
  poll();
}
unlock();

function mediaUrl(songId, cdgFlag) {
  return cdgFlag ? `/media/${songId}/cdg` : `/media/${songId}`;
}

function hideAll() {
  video.style.display = "none";
  canvas.style.display = "none";
  overlay.style.display = "none";
  idle.style.display = "";
}

function showOverlay(it) {
  singerEl.textContent = "🎤 " + it.singer;
  titleEl.textContent = it.title + (it.artist ? " — " + it.artist : "");
  overlay.style.display = "";
}

function onEnded() {
  // A passive viewer's own video reaching its end doesn't mean the song is
  // actually over — the host laptop is the only authority on that. Just
  // stop trying to auto-restart; the next poll() will pick up whatever the
  // host is really doing (including drift-correcting us back into the song
  // if we finished early due to decoder drift).
  songEnded = true;
}

async function loadSong(it, startAt, status) {
  currentQueueId = it.queue_id;
  currentKind = it.kind;
  cdgActive = false;
  songEnded = false;
  idle.style.display = "none";

  // Join an already-playing song where it currently is, rather than
  // restarting it from 0:00 — this page can be opened at any point mid-song.
  // Ignore anything under 2s: a brand-new song resets to position 0 on the
  // server, but server-clock extrapolation may have nudged it forward a
  // touch by the time this poll reads it back. Once we do seek, aim
  // LEAD_SECONDS ahead of the host's reported position — R2/CDN fetch +
  // decode latency otherwise shows up as this player lagging the host by
  // about that much in practice, so starting with a head start cancels it
  // out instead of correcting for it after the fact.
  const rawStart = startAt || 0;
  function seekOnceReady(m) {
    if (rawStart < 2) return;
    const seekTo = rawStart + LEAD_SECONDS;
    if (m.readyState >= 1) { m.currentTime = seekTo; return; }
    m.addEventListener("loadedmetadata", () => { m.currentTime = seekTo; }, { once: true });
  }

  if (it.kind === "video") {
    audio.pause(); audio.removeAttribute("src");
    canvas.style.display = "none";
    video.style.display = "";
    video.pause();
    video.src = mediaUrl(it.song_id, false);
    video.volume = volume;
    video.onended = onEnded;
    seekOnceReady(video);
    if (unlocked && status === "playing") video.play().catch(() => {});
  } else {
    video.pause(); video.removeAttribute("src");
    video.style.display = "none";
    audio.pause();
    audio.src = mediaUrl(it.song_id, false);
    audio.volume = volume;
    audio.onended = onEnded;
    seekOnceReady(audio);
    if (it.kind === "cdg") {
      canvas.style.display = "";
      try {
        const buf = await fetch(mediaUrl(it.song_id, true)).then(r => r.arrayBuffer());
        await cdg.load(buf);
        cdgActive = true;
      } catch (e) { canvas.style.display = "none"; }
    } else {
      canvas.style.display = "none";
    }
    if (unlocked && status === "playing") audio.play().catch(() => {});
  }
  showOverlay(it);
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    let state;
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3000);
      try { state = await fetch("/api/player/state", { signal: ctrl.signal }).then(r => r.json()); }
      finally { clearTimeout(tid); }
    } catch (e) { return; }
    if (!state || typeof state.status === "undefined") return;

    volume = state.volume ?? 1.0;
    video.volume = volume; audio.volume = volume;

    if (!state.current) {
      currentQueueId = null; currentKind = null;
      video.pause(); audio.pause();
      hideAll();
      return;
    }
    if (state.current.queue_id !== currentQueueId) { await loadSong(state.current, state.position, state.status); return; }

    const m = activeMedia();
    const drift = isFinite(m.currentTime) ? Math.abs(m.currentTime - state.position) : 0;
    if (state.seek_to != null) {
      // An explicit admin seek/restart — everyone follows this.
      m.currentTime = state.seek_to;
      lastCorrectionAt = Date.now();
    } else if (state.status === "playing" && drift > 8) {
      // A big jump (restart/seek) always applies immediately, bypassing the
      // cooldown below. This player never acknowledges seek_to (it's
      // read-only), but the HOST does — and the host's ack can clear
      // seek_to before this player's next poll ever reads it, especially
      // over a slower off-site connection. Without this, a restart landing
      // in that gap would be silently missed entirely (this player just
      // keeps playing wherever it already was) rather than merely delayed.
      // A drift this large can't be normal decode drift, so treat it as a
      // seek regardless of how it got missed.
      m.currentTime = state.position;
      lastCorrectionAt = Date.now();
    } else if (state.status === "playing" && drift > 2 &&
               Date.now() - lastCorrectionAt > 4000) {
      // Same loose (2s) drift-correction safety net used by the LAN player.
      // Note: no LEAD_SECONDS here — the head start only applies once, at
      // the start of a song (loadSong above); ongoing correction targets
      // the host's actual position, not the offset one, or the lead would
      // just get baked into steady-state playback instead of being a
      // one-time compensation for initial fetch/decode latency.
      // Plus a 4s cooldown between attempts that the LAN player doesn't
      // need: correcting currentTime against an R2/CDN stream forces a
      // re-buffer, and while that's in flight (m.seeking stays true) a
      // guard of "!m.seeking" would just block every following correction
      // until it clears — on a slow connection that can outlast the 1s
      // poll, so drift keeps compounding while corrections stay locked out
      // (the "player escapes the host" symptom). A flat cooldown instead
      // gives each re-buffer a fixed window to finish before trying again.
      m.currentTime = state.position;
      lastCorrectionAt = Date.now();
    }

    if (state.status === "playing" && m.paused && unlocked && !songEnded) m.play().catch(() => {});
    else if (state.status === "paused" && !m.paused) m.pause();
    else if (state.status === "stopped") m.pause();
  } finally {
    polling = false;
  }
}

function renderLoop() {
  if (cdgActive && currentKind === "cdg") cdg.render(audio.currentTime);
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);
setInterval(poll, 1000);
