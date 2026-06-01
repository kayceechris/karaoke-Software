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

let searchTimer = null;
let pendingSong = null;

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

async function loadNow() {
  let st;
  try { st = await api("/api/player/state"); } catch (e) { return; }
  if (st.current) {
    nowEl.classList.remove("idle");
    npTitle.textContent = st.current.title;
    npMeta.innerHTML =
      (st.current.artist || "Unknown") +
      ' · <span class="singer">🎤 ' + st.current.singer + "</span>";
  } else {
    nowEl.classList.add("idle");
    npTitle.textContent = "Welcome to Melbourne Karaoke";
    npMeta.textContent = "Search a song below and add it to the queue";
  }
}

qEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 200);
});

search();
loadQueue();
loadNow();
setInterval(() => { loadQueue(); loadNow(); }, 4000);
