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
  // Tablets are passive followers of the shared queue, never the authority
  // on it — only the host's own player (wired to the actual sound system)
  // should ever call /api/player/ended. If a tablet's video finishes first
  // (easily possible once its start time is deliberately offset from the
  // host's), it must NOT advance the queue for everyone else. Just freeze
  // here and wait for the next poll to say what's actually current.
  songEnded = true;
}

async function loadSong(it, startAt) {
  currentQueueId = it.queue_id;
  currentKind = it.kind;
  cdgActive = false;
  songEnded = false;
  idle.style.display = "none";

  video.pause(); audio.pause();
  video.playbackRate = 1; audio.playbackRate = 1;
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
  // Guard against overlap: a slow response could still be in flight when
  // the next tick fires. Without this, an older response landing after a
  // newer one could see a stale queue_id and "helpfully" switch back to
  // the song that's no longer playing.
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
      const m = activeMedia();
      if (st.seek_to != null) {
        m.currentTime = st.seek_to;
        m.playbackRate = 1;
        api("/api/player/seeked", { method: "POST" }).catch(() => {});
      } else if (st.status === "playing" && !m.seeking && isFinite(m.currentTime)) {
        // A tablet's decoder can genuinely run at a slightly different
        // effective rate than the host's — a periodic hard position-jump
        // can't fix that (it just re-drifts at the same wrong rate between
        // corrections, and visibly jumps the picture each time). Nudge
        // playbackRate instead: a barely perceptible speed tweak that
        // continuously pulls it back in line. Reserve the hard jump for a
        // drift big enough that nudging would take too long to catch up.
        const drift = m.currentTime - st.position;
        if (Math.abs(drift) > 3) {
          m.currentTime = st.position;
          m.playbackRate = 1;
        } else if (Math.abs(drift) > 0.3) {
          // Scale the correction with how far off it is — a fixed small
          // nudge isn't necessarily strong enough for the true underlying
          // rate mismatch, but a big one would be audible/visible for tiny
          // drift. Ramps from barely-there up to a firm (but still not
          // jarring) pull as drift approaches the hard-snap threshold.
          const correction = Math.min(0.2, Math.abs(drift) * 0.08);
          m.playbackRate = drift > 0 ? 1 - correction : 1 + correction;
        } else if (m.playbackRate !== 1) {
          m.playbackRate = 1;
        }
      }

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

// Position/duration reporting is the host's job only (it's the one wired to
// the actual sound system) — tablets must not write to the shared player
// state, or their own timing drift would corrupt the admin seek bar and
// could race with the host's own reports.

qEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 200);
});

search();
loadQueue();
loadNow();
// Polling faster than this made drift-correction re-seeks frequent enough
// to visibly jump the video/lyrics while someone was following along —
// once a second is a smoother trade-off even if it's a bit slower to
// notice a new song.
setInterval(loadNow, 1000);
setInterval(loadQueue, 4000);
