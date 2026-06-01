const qEl = document.getElementById("q");
const resultsEl = document.getElementById("results");
const queueEl = document.getElementById("queue");

let searchTimer = null;
let rememberedSinger = localStorage.getItem("singer") || "";

async function search() {
  const q = qEl.value.trim();
  const songs = await api("/api/songs?q=" + encodeURIComponent(q));
  resultsEl.innerHTML = "";
  if (!songs.length) {
    resultsEl.innerHTML = '<div class="empty">No songs found.</div>';
    return;
  }
  for (const s of songs) {
    const div = document.createElement("div");
    div.className = "song";
    div.innerHTML = `
      <div class="meta">
        <div class="title"></div>
        <div class="artist"></div>
      </div>
      <span class="tag"></span>
      <button class="primary">Request</button>`;
    div.querySelector(".title").textContent = s.title;
    div.querySelector(".artist").textContent = s.artist || "Unknown artist";
    div.querySelector(".tag").textContent = KIND_LABEL[s.kind] || s.kind;
    div.querySelector("button").onclick = () => request(s);
    resultsEl.appendChild(div);
  }
}

async function request(song) {
  let singer = prompt("Singer name?", rememberedSinger || "");
  if (singer === null) return;
  singer = singer.trim() || "Guest";
  rememberedSinger = singer;
  localStorage.setItem("singer", singer);
  await api("/api/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ song_id: song.id, singer }),
  });
  toast(`Added "${song.title}" for ${singer}`);
  loadQueue();
}

async function loadQueue() {
  const items = await api("/api/queue");
  queueEl.innerHTML = "";
  if (!items.length) {
    queueEl.innerHTML = '<div class="empty">Queue is empty.</div>';
    return;
  }
  items.forEach((it, i) => {
    const div = document.createElement("div");
    div.className = "song queue-item" + (it.status === "playing" ? " playing" : "");
    div.innerHTML = `
      <div class="pos">${it.status === "playing" ? "▶" : i}</div>
      <div class="meta"><div class="title"></div><div class="artist"></div></div>`;
    div.querySelector(".title").textContent = it.title;
    div.querySelector(".artist").textContent =
      (it.artist || "Unknown") + " · " + it.singer;
    queueEl.appendChild(div);
  });
}

qEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 200);
});

search();
loadQueue();
setInterval(loadQueue, 4000);
