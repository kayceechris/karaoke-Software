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

tapstart.addEventListener("click", async () => {
  unlocked = true;
  tapstart.style.display = "none";
  try { await video.play().catch(() => {}); video.pause(); } catch (e) {}
  try { await audio.play().catch(() => {}); audio.pause(); } catch (e) {}
  poll();
});

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

async function loadSong(it) {
  currentQueueId = it.queue_id;
  currentKind = it.kind;
  cdgActive = false;
  songEnded = false;
  idle.style.display = "none";
  video.pause(); audio.pause();
  video.removeAttribute("src"); video.load();

  if (it.kind === "video") {
    video.style.display = ""; canvas.style.display = "none";
    video.src = mediaUrl(it.song_key, false);
    video.volume = volume;
    video.onended = onEnded;
    if (unlocked) video.play().catch(() => {});
  } else {
    video.style.display = "none";
    audio.src = mediaUrl(it.song_key, false);
    audio.volume = volume;
    audio.onended = onEnded;
    if (it.kind === "cdg") {
      canvas.style.display = "";
      try {
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
    try { state = await fetch("/api/state").then(r => r.json()); }
    catch (e) { return; }
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
    if (state.current.queue_id !== currentQueueId) { await loadSong(state.current); return; }

    const m = activeMedia();
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
