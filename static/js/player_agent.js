// Player for HYBRID mode. Talks ONLY to the local agent:
//   GET  /api/state            -> proxied cloud player state (has song_key)
//   GET  /local-media/<key>    -> local media file  (?cdg=1 for the .cdg)
//   POST /api/ended            -> tell cloud the song finished
const video = document.getElementById("video");
const audio = document.getElementById("audio");
const canvas = document.getElementById("cdg");
const idle = document.getElementById("idle");
const overlay = document.getElementById("overlay");
const titleEl = document.getElementById("title");
const singerEl = document.getElementById("singer");
const tapstart = document.getElementById("tapstart");

const cdg = new CDGPlayer(canvas);

let unlocked = false;
let currentQueueId = null;
let currentKind = null;
let volume = 1.0;
let cdgActive = false;
let songEnded = false;

// agent.py launches the ONE sanctioned host instance itself with
// ?autoplay=1 and a Chromium flag that permits autoplay-with-sound. Anyone
// else on the same Wi-Fi could also open this /player URL manually — mute
// that case so they can't accidentally produce a second, conflicting audio
// source; only the actual auto-launched host player has real sound.
const IS_HOST_INSTANCE = new URLSearchParams(location.search).get("autoplay") === "1";
if (!IS_HOST_INSTANCE) { video.muted = true; audio.muted = true; }

async function unlock() {
  unlocked = true;
  tapstart.style.display = "none";
  try { await video.play().catch(() => {}); video.pause(); } catch (e) {}
  try { await audio.play().catch(() => {}); audio.pause(); } catch (e) {}
  poll();
}

tapstart.addEventListener("click", unlock);

// Skip the manual tap for the sanctioned host instance — audio starts as
// soon as the agent is running, nothing to click.
if (IS_HOST_INSTANCE) unlock();

function mediaUrl(key, cdgFlag) {
  const u = "/local-media/" + key.split("/").map(encodeURIComponent).join("/");
  return cdgFlag ? u + "?cdg=1" : u;
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
  songEnded = true;
  fetch("/api/ended", { method: "POST" }).catch(() => {});
}

function reportPosition() {
  if (!currentQueueId) return;
  const m = activeMedia();
  if (!m || !isFinite(m.duration) || m.duration === 0) return;
  fetch("/api/position", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ position: m.currentTime, duration: m.duration }),
  }).catch(() => {});
}
setInterval(reportPosition, 3000);

async function loadSong(it, startAt) {
  currentQueueId = it.queue_id;
  currentKind = it.kind;
  cdgActive = false;
  songEnded = false;
  idle.style.display = "none";

  // Join an already-playing song where it currently is, rather than
  // restarting it from 0:00 — matters whenever this page is (re)opened
  // mid-song, whether that's the host agent recovering or someone else on
  // the Wi-Fi opening the same URL.
  const seekTo = startAt || 0;
  function seekOnceReady(m) {
    if (seekTo <= 0) return;
    if (m.readyState >= 1) { m.currentTime = seekTo; return; }
    m.addEventListener("loadedmetadata", () => { m.currentTime = seekTo; }, { once: true });
  }

  if (it.kind === "video") {
    // Pause and release audio so it doesn't keep buffering in background
    audio.pause(); audio.removeAttribute("src");
    canvas.style.display = "none";
    video.style.display = "";
    video.pause();
    video.src = mediaUrl(it.song_key, false);   // browser aborts old + starts new immediately
    video.volume = volume;
    video.onended = onEnded;
    seekOnceReady(video);
    if (unlocked) video.play().catch(() => {});
  } else {
    // Pause and release video
    video.pause(); video.removeAttribute("src");
    video.style.display = "none";
    audio.pause();
    audio.src = mediaUrl(it.song_key, false);   // start buffering audio right away
    audio.volume = volume;
    audio.onended = onEnded;
    seekOnceReady(audio);
    if (it.kind === "cdg") {
      canvas.style.display = "";
      try {
        // CDG fetch and audio buffer run in parallel
        const buf = await fetch(mediaUrl(it.song_key, true)).then(r => r.arrayBuffer());
        await cdg.load(buf);
        cdgActive = true;
      } catch (e) { canvas.style.display = "none"; }
    } else {
      canvas.style.display = "none";
    }
    if (unlocked) audio.play().catch(() => {});
  }
  showOverlay(it);
}

function activeMedia() { return currentKind === "video" ? video : audio; }

let polling = false;
async function poll() {
  if (polling) return;        // don't overlap: a slow cloud reply could double-load
  polling = true;
  try {
    let state;
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3000);
      try { state = await fetch("/api/state", { signal: ctrl.signal }).then(r => r.json()); }
      finally { clearTimeout(tid); }
    } catch (e) { return; }
    // Skip ticks where the cloud was unreachable or the reply is malformed —
    // keep playing the current song instead of resetting it.
    if (!state || state.unavailable || typeof state.status === "undefined") return;

    volume = state.volume ?? 1.0;
    video.volume = volume; audio.volume = volume;

    if (!state.current) {
      currentQueueId = null; currentKind = null;
      video.pause(); audio.pause();
      hideAll();
      return;
    }
    if (state.current.queue_id !== currentQueueId) { await loadSong(state.current, state.position); return; }

    const m = activeMedia();
    if (state.seek_to != null) {
      m.currentTime = state.seek_to;
      fetch("/api/seeked", { method: "POST" }).catch(() => {});
    } else if (!IS_HOST_INSTANCE && state.status === "playing" && !m.seeking &&
               isFinite(m.currentTime) && Math.abs(m.currentTime - state.position) > 0.4) {
      // Drift correction only for a non-sanctioned viewer of this same URL.
      // The host instance IS the source of truth feeding the live PA sound
      // — seeking it against itself would just click/glitch the actual show
      // audio for no reason.
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

// The sanctioned host instance drives the actual show — it needs to keep
// following play/pause/next/stop commands and song changes continuously.
// Anyone else opening this same URL is just a supplementary viewer; check
// what's currently playing once and leave it at that, rather than
// repeatedly polling a device that isn't the source of truth for anything.
if (IS_HOST_INSTANCE) {
  setInterval(poll, 1000);
} else {
  poll();
}
