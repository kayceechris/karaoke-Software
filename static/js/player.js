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

// Browsers block autoplay until a user gesture. One tap unlocks both elements.
tapstart.addEventListener("click", async () => {
  unlocked = true;
  tapstart.style.display = "none";
  try { await video.play().catch(() => {}); video.pause(); } catch (e) {}
  try { await audio.play().catch(() => {}); audio.pause(); } catch (e) {}
  poll();
});

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
  api("/api/player/ended", { method: "POST" }).catch(() => {});
}

async function loadSong(it) {
  currentQueueId = it.queue_id;
  currentKind = it.kind;
  cdgActive = false;
  idle.style.display = "none";

  // stop whatever was running
  video.pause(); audio.pause();
  video.removeAttribute("src"); video.load();

  if (it.kind === "video") {
    video.style.display = "";
    canvas.style.display = "none";
    video.src = "/media/" + it.song_id;
    video.volume = volume;
    video.onended = onEnded;
    if (unlocked) video.play().catch(() => {});
  } else {
    // cdg or audio -> HTML5 audio + (optional) canvas graphics
    video.style.display = "none";
    audio.src = "/media/" + it.song_id;
    audio.volume = volume;
    audio.onended = onEnded;
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
    if (unlocked) audio.play().catch(() => {});
  }
  showOverlay(it);
}

function activeMedia() {
  return currentKind === "video" ? video : audio;
}

async function poll() {
  let state;
  try {
    state = await api("/api/player/state");
  } catch (e) {
    return;
  }
  volume = state.volume;
  video.volume = volume;
  audio.volume = volume;

  if (!state.current) {
    currentQueueId = null;
    currentKind = null;
    video.pause(); audio.pause();
    hideAll();
    return;
  }

  if (state.current.queue_id !== currentQueueId) {
    await loadSong(state.current);
    return;
  }

  // same song -> reconcile play/pause
  const m = activeMedia();
  if (state.status === "playing" && m.paused && unlocked) {
    m.play().catch(() => {});
  } else if (state.status === "paused" && !m.paused) {
    m.pause();
  } else if (state.status === "stopped") {
    m.pause();
  }
}

// CDG render loop, synced to audio playback time
function renderLoop() {
  if (cdgActive && currentKind === "cdg") {
    cdg.render(audio.currentTime);
  }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

setInterval(poll, 1000);
