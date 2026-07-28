// Cloud player: a muted, video-only companion to the host's local player.
// Talks directly to the cloud queue API (this page IS the cloud). Always
// muted — the venue's DJ system is the only real audio source; if many
// guests scanned the QR code and opened this with real sound, you'd get a
// room full of conflicting audio.
const video = document.getElementById("video");
const audio = document.getElementById("audio");
const canvas = document.getElementById("cdg");
const idle = document.getElementById("idle");
const overlay = document.getElementById("overlay");
const titleEl = document.getElementById("title");
const singerEl = document.getElementById("singer");

const cdg = new CDGPlayer(canvas);
video.muted = true;
audio.muted = true;

let currentQueueId = null;
let currentKind = null;
let cdgActive = false;
let songEnded = false;

function activeMedia() {
  return currentKind === "video" ? video : audio;
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
  // Passive follower only — never tells the server the song ended. Only
  // the host's own player (wired to the actual sound system) does that;
  // this page finishing first (or last) must not advance the shared queue.
  songEnded = true;
}

async function loadSong(it, startAt) {
  currentQueueId = it.queue_id;
  currentKind = it.kind;
  cdgActive = false;
  songEnded = false;
  idle.style.display = "none";

  video.pause(); audio.pause();
  video.removeAttribute("src"); video.load();

  // Join an already-playing song where it currently is, rather than
  // restarting it from 0:00 — matters whenever this page is opened (or
  // reopened) mid-song.
  const seekTo = startAt || 0;
  function seekOnceReady(m) {
    if (seekTo <= 0) return;
    if (m.readyState >= 1) { m.currentTime = seekTo; return; }
    m.addEventListener("loadedmetadata", () => { m.currentTime = seekTo; }, { once: true });
  }

  if (it.kind === "video") {
    video.style.display = "";
    canvas.style.display = "none";
    video.src = "/media/" + it.song_id;
    video.onended = onEnded;
    seekOnceReady(video);
    video.play().catch(() => {});
  } else {
    video.style.display = "none";
    audio.src = "/media/" + it.song_id;
    audio.onended = onEnded;
    seekOnceReady(audio);
    if (it.kind === "cdg") {
      canvas.style.display = "";
      try {
        const buf = await fetch("/media/" + it.song_id + "/cdg")
          .then((r) => r.arrayBuffer());
        await cdg.load(buf);
        cdgActive = true;
      } catch (e) {
        canvas.style.display = "none";
      }
    } else {
      canvas.style.display = "none";
    }
    audio.play().catch(() => {});
  }
  showOverlay(it);
}

let _pollBusy = false;
async function poll() {
  if (_pollBusy) return;
  _pollBusy = true;
  try {
    await _poll();
  } finally {
    _pollBusy = false;
  }
}

async function _poll() {
  let st;
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 4000);
    try { st = await fetch("/api/player/state", { signal: ctrl.signal }).then((r) => r.json()); }
    finally { clearTimeout(tid); }
  } catch (e) { return; }

  if (!st.current) {
    currentQueueId = null;
    currentKind = null;
    video.pause(); audio.pause();
    hideAll();
    return;
  }

  if (st.current.queue_id !== currentQueueId) {
    await loadSong(st.current, st.position);
    return;
  }

  const m = activeMedia();
  if (st.seek_to != null) {
    m.currentTime = st.seek_to;
  } else if (st.status === "playing" && !m.seeking && isFinite(m.currentTime) &&
             Math.abs(m.currentTime - st.position) > 0.4) {
    // Correcting position directly every poll (rather than nudging
    // playbackRate) — currentTime seeking is reliable across every device,
    // and catching drift early keeps each correction small.
    m.currentTime = st.position;
  }

  if (st.status === "playing" && m.paused && !songEnded) {
    m.play().catch(() => {});
  } else if (st.status === "paused" && !m.paused) {
    m.pause();
  } else if (st.status === "stopped") {
    m.pause();
  }
}

function renderLoop() {
  if (cdgActive && currentKind === "cdg") {
    cdg.render(audio.currentTime);
  }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

poll();
setInterval(poll, 1000);
