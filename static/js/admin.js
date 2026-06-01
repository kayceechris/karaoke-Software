const queueEl = document.getElementById("queue");
const nowTitle = document.getElementById("nowtitle");
const volEl = document.getElementById("vol");

// In hybrid/cloud mode the admin actions need the host token. Ask once, store it.
if (window.NEEDS_AUTH && !localStorage.getItem("host_token")) {
  const t = prompt("Enter host token (set as HOST_TOKEN on the server):", "");
  if (t) localStorage.setItem("host_token", t.trim());
}

async function cmd(action, value) {
  await api("/api/player/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, value }),
  });
  refresh();
}

document.getElementById("play").onclick = () => cmd("play");
document.getElementById("pause").onclick = () => cmd("pause");
document.getElementById("next").onclick = () => cmd("next");
document.getElementById("stop").onclick = () => cmd("stop");
volEl.oninput = () => cmd("volume", parseFloat(volEl.value));

document.getElementById("reindex").onclick = async () => {
  const r = await api("/api/reindex", { method: "POST" });
  toast(`Indexed ${r.count} songs`);
  refresh();
};

async function refresh() {
  const [state, items] = await Promise.all([
    api("/api/player/state"),
    api("/api/queue"),
  ]);

  nowTitle.textContent = state.current
    ? `${state.current.title} — ${state.current.artist || "Unknown"} (${state.current.singer}) · ${state.status}`
    : "—";
  if (document.activeElement !== volEl) volEl.value = state.volume;

  queueEl.innerHTML = "";
  if (!items.length) {
    queueEl.innerHTML = '<div class="empty">Queue is empty.</div>';
    return;
  }
  items.forEach((it, i) => {
    const playing = it.status === "playing";
    const div = document.createElement("div");
    div.className = "song queue-item" + (playing ? " playing" : "");
    div.innerHTML = `
      <div class="pos">${playing ? "▶" : i}</div>
      <div class="meta"><div class="title"></div><div class="artist"></div></div>
      <span class="tag"></span>`;
    div.querySelector(".title").textContent = it.title;
    div.querySelector(".artist").textContent =
      (it.artist || "Unknown") + " · " + it.singer;
    div.querySelector(".tag").textContent = KIND_LABEL[it.kind] || it.kind;

    if (!playing) {
      const top = document.createElement("button");
      top.className = "ghost";
      top.textContent = "↑ Top";
      top.onclick = async () => {
        await api(`/api/queue/${it.id}/top`, { method: "POST" });
        refresh();
      };
      div.appendChild(top);
    }
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "✕";
    del.onclick = async () => {
      await api(`/api/queue/${it.id}`, { method: "DELETE" });
      refresh();
    };
    div.appendChild(del);
    queueEl.appendChild(div);
  });
}

refresh();
setInterval(refresh, 3000);
