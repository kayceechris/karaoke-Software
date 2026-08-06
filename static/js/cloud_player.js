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
  // touch by the time this poll reads it back.
  const seekTo = startAt || 0;
  function seekOnceReady(m) {
    if (seekTo < 2) return;
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
      // An explicit admin seek/restart — everyone follows this. This player
      // never acknowledges seek_to (it's read-only), but the host does, and
      // the host's ack can clear seek_to before this player's next poll
      // ever reads it — the plain drift check below catches a missed
      // restart too (the resulting gap is far past the drift threshold).
      m.currentTime = state.seek_to;
    } else if (state.status === "playing" && drift > 5) {
      // Correcting currentTime causes a visible decode/keyframe hiccup even
      // when nothing stalls on the network (confirmed via DevTools — no
      // stalled requests, the stutter is purely from seeking itself). The
      // LAN player's tight 2s threshold is fine there because true drift is
      // rare enough that it almost never fires; over R2 the position report
      // round-trip alone can put the reading a couple seconds off on any
      // given poll, so a tight threshold ends up correcting on nearly every
      // 1s tick — a continuous stutter instead of an occasional one. A
      // looser threshold accepts a few seconds of slack so corrections stay
      // rare, only stepping in for drift big enough to actually matter.
      m.currentTime = state.position;
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
