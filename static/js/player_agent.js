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
// ?autoplay=1. Anyone else on the same Wi-Fi could also open this /player
// URL manually — that case stays muted always, so it can't accidentally
// produce a second, conflicting audio source; only the host player has
// real sound.
const IS_HOST_INSTANCE = new URLSearchParams(location.search).get("autoplay") === "1";

// Every instance starts muted, always — browsers allow muted autoplay
// unconditionally, no special flags or gestures needed, unlike autoplay
// WITH sound (which --autoplay-policy is supposed to permit but isn't
// reliable in practice — depends on it being a genuinely fresh browser
// process, which isn't guaranteed). The host instance unmutes itself right
// after playback actually begins instead: toggling .muted on an
// already-playing element doesn't require a fresh user gesture, only
// *starting* playback with sound does — so this sidesteps the flag
// entirely and just works.
video.muted = true;
audio.muted = true;

function startPlayback(m) {
  const p = m.play();
  if (IS_HOST_INSTANCE) {
    Promise.resolve(p).then(() => { m.muted = false; }).catch(() => {});
  } else {
    Promise.resolve(p).catch(() => {});
  }
}

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
  // Only the sanctioned host instance is authoritative here — it's driving
  // the actual show, so its video finishing really does mean the song is
  // over. A non-host viewer's video can reach its own end first (any small
  // drift, uncorrected now, adds up over a song) and must NOT be allowed to
  // advance the queue for everyone and cut the host off mid-song.
  if (IS_HOST_INSTANCE) {
    fetch("/api/ended", { method: "POST" }).catch(() => {});
  }
}

function reportPosition() {
  // Host-only, same reasoning as onEnded above — a non-host viewer's own
  // (uncorrected, possibly drifting) position must not overwrite the shared
  // state that everyone else's mid-song joins and the admin seek bar rely on.
  if (!IS_HOST_INSTANCE || !currentQueueId) return;
  const m = activeMedia();
  if (!m || !isFinite(m.duration) || m.duration === 0) return;
  fetch("/api/position", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ position: m.currentTime, duration: m.duration, queue_id: currentQueueId }),
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
  // the Wi-Fi opening the same URL. Ignore anything under 2s though: a
  // brand-new song (Next/ended) resets to position 0 on the server, but by
  // the time this poll reads it back, server-clock extrapolation has
  // already nudged it forward a little — without this, a fresh song would
  // never quite start at true 0:00.
  const seekTo = startAt || 0;
  function seekOnceReady(m) {
    if (seekTo < 2) return;
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
    if (unlocked) startPlayback(video);
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
    if (unlocked) startPlayback(audio);
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
      // An explicit admin seek/restart — everyone follows this, host and
      // viewers alike. Only the host acknowledges it, though: if a viewer's
      // ack cleared seek_to first, the host could miss applying it entirely
      // on its own next poll.
      m.currentTime = state.seek_to;
      if (IS_HOST_INSTANCE) {
        fetch("/api/seeked", { method: "POST" }).catch(() => {});
      }
    }
    // No passive drift correction here: a non-host viewer already joined at
    // the right position when the song loaded (see loadSong's seekOnceReady)
    // and just keeps playing from there — it still follows song changes and
    // play/pause/stop below, but isn't repeatedly re-synced against the
    // host's position.

    if (state.status === "playing" && m.paused && unlocked && !songEnded) startPlayback(m);
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
