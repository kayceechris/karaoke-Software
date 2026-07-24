const qEl = document.getElementById("q");
const resultsEl = document.getElementById("results");
const queueEl = document.getElementById("queue");
const nowEl = document.getElementById("nowPlaying");
const npTitle = document.getElementById("npTitle");
const npMeta = document.getElementById("npMeta");

const modal = document.getElementById("reqModal");
const reqSongTitle = document.getElementById("reqSongTitle");
const reqSinger = document.getElementById("reqSinger");
const reqConfirm = document.getElementById("reqConfirm");
const reqCancel = document.getElementById("reqCancel");

const video = document.getElementById("video");
const audio = document.getElementById("audio");
const canvas = document.getElementById("cdg");
const idle = document.getElementById("idle");
const cdg = new CDGPlayer(canvas);

// Guests watch the video for fun, but the venue's TV/speakers are the real
// sound — muted here so every phone doesn't also blast audio out of sync.
video.muted = true;
audio.muted = true;

// Keep the sticky player pinned right below the appbar (its height varies
// across the responsive breakpoints), so it stays visible while scrolling.
const appbarEl = document.querySelector(".appbar");
function syncHeaderHeight() {
  document.documentElement.style.setProperty("--header-h", appbarEl.offsetHeight + "px");
}
syncHeaderHeight();
window.addEventListener("resize", syncHeaderHeight);

let searchTimer = null;
let pendingSong = null;
let currentQueueId = null;
let currentKind = null;
let playerVolume = 1.0;
let cdgActive = false;
let songEnded = false;

function stagger(container) {
  [...container.children].forEach((c, i) => {
    c.style.animationDelay = Math.min(i * 40, 400) + "ms";
  });
}

async function search() {
  const q = qEl.value.trim();
  const songs = await api("/api/songs?q=" + encodeURIComponent(q));
  resultsEl.innerHTML = "";
  if (!songs.length) {
    resultsEl.innerHTML =
      '<div class="empty"><div class="big">🎙️</div>No songs found — try another search.</div>';
    return;
  }
  for (const s of songs) {
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `
      <div class="meta">
        <div class="title"></div>
        <div class="artist"></div>
      </div>
      <span class="tag"></span>
      <button class="btn btn-primary">Request</button>`;
    div.prepend(coverEl(s));
    div.querySelector(".title").textContent = s.title;
    div.querySelector(".artist").textContent = s.artist || "Unknown artist";
    div.querySelector(".tag").textContent = (KIND_LABEL[s.kind] || s.kind);
    div.querySelector("button").onclick = () => openRequest(s);
    resultsEl.appendChild(div);
  }
  stagger(resultsEl);
}

function openRequest(song) {
  pendingSong = song;
  reqSongTitle.textContent = song.title + (song.artist ? " — " + song.artist : "");
  reqSinger.value = localStorage.getItem("singer") || "";
  modal.classList.add("show");
  setTimeout(() => reqSinger.focus(), 150);
}

function closeRequest() {
  modal.classList.remove("show");
  pendingSong = null;
}

async function confirmRequest() {
  if (!pendingSong) return;
  const singer = (reqSinger.value || "Guest").trim() || "Guest";
  localStorage.setItem("singer", singer);
  const song = pendingSong;
  closeRequest();
  await api("/api/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ song_id: song.id, singer }),
  });
  toast(`Added "${song.title}" for ${singer}`);
  loadQueue();
}

reqConfirm.onclick = confirmRequest;
reqCancel.onclick = closeRequest;
modal.onclick = (e) => { if (e.target === modal) closeRequest(); };
reqSinger.addEventListener("keydown", (e) => { if (e.key === "Enter") confirmRequest(); });

async function loadQueue() {
  const items = await api("/api/queue");
  queueEl.innerHTML = "";
  if (!items.length) {
    queueEl.innerHTML = '<div class="empty">Queue is empty — be the first to sing! 🎉</div>';
    return;
  }
  items.forEach((it, i) => {
    const playing = it.status === "playing";
    const div = document.createElement("div");
    div.className = "card queue-item" + (playing ? " playing" : "");
    div.innerHTML = `
      <div class="pos">${playing ? "▶" : i}</div>
      <div class="meta"><div class="title"></div><div class="artist"></div></div>`;
    div.children[0].after(coverEl(it));
    div.querySelector(".title").textContent = it.title;
    div.querySelector(".artist").textContent =
      (it.artist || "Unknown") + " · 🎤 " + it.singer;
    queueEl.appendChild(div);
  });
  stagger(queueEl);
}

function activeMedia() {
  return currentKind === "video" ? video : audio;
}

function hidePlayer() {
  video.style.display = "none";
  canvas.style.display = "none";
  idle.style.display = "";
}

function onEnded() {
  songEnded = true;
  api("/api/player/ended", { method: "POST" }).catch(() => {});
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
  // restarting it from 0:00 — matters when a second guest opens the
  // tablet after the song has already been running for a while.
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
    video.volume = playerVolume;
    video.onended = onEnded;
    seekOnceReady(video);
    video.play().catch(() => {});
  } else {
    video.style.display = "none";
    audio.src = "/media/" + it.song_id;
    audio.volume = playerVolume;
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
}

let _loadNowBusy = false;
async function loadNow() {
  // Guard against overlap: at a 400ms poll interval, a slow response could
  // still be in flight when the next tick fires. Without this, an older
  // response landing after a newer one could see a stale queue_id and
  // "helpfully" switch back to the song that's no longer playing.
  if (_loadNowBusy) return;
  _loadNowBusy = true;
  try {
    await _loadNow();
  } finally {
    _loadNowBusy = false;
  }
}

async function _loadNow() {
  let st;
  try { st = await api("/api/player/state"); } catch (e) { return; }
  playerVolume = st.volume;
  video.volume = playerVolume;
  audio.volume = playerVolume;

  if (st.current) {
    nowEl.classList.remove("idle");
    npTitle.textContent = st.current.title;
    npMeta.innerHTML =
      (st.current.artist || "Unknown") +
      ' · <span class="singer">🎤 ' + st.current.singer + "</span>";

    if (st.current.queue_id !== currentQueueId) {
      await loadSong(st.current, st.position);
    } else {
      if (st.seek_to != null) {
        activeMedia().currentTime = st.seek_to;
        api("/api/player/seeked", { method: "POST" }).catch(() => {});
      }
      const m = activeMedia();
      if (st.status === "playing" && m.paused && !songEnded) {
        m.play().catch(() => {});
      } else if (st.status === "paused" && !m.paused) {
        m.pause();
      } else if (st.status === "stopped") {
        m.pause();
      }
    }
  } else {
    nowEl.classList.add("idle");
    npTitle.textContent = "Welcome to Melbourne Karaoke";
    npMeta.textContent = "Search a song below and add it to the queue";
    currentQueueId = null;
    currentKind = null;
    video.pause(); audio.pause();
    hidePlayer();
  }
}

function renderLoop() {
  if (cdgActive && currentKind === "cdg") {
    cdg.render(audio.currentTime);
  }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// Report playback time so the admin seek bar / progress readout stays live.
function reportPosition() {
  if (!currentQueueId) return;
  const m = activeMedia();
  if (!m || !isFinite(m.duration) || m.duration === 0) return;
  api("/api/player/position", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ position: m.currentTime, duration: m.duration }),
  }).catch(() => {});
}
setInterval(reportPosition, 3000);

qEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 200);
});

search();
loadQueue();
loadNow();
// Tighter than the 1s default: the host's TV plays its video from a local
// file (near-instant start), while a tablet's video streams over the
// network from R2 — every millisecond of detection delay here adds
// directly to how far behind the host's audio the tablet looks.
setInterval(loadNow, 400);
setInterval(loadQueue, 4000);
