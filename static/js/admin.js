const queueEl = document.getElementById("queue");
const nowEl = document.getElementById("nowPlaying");
const npTitle = document.getElementById("npTitle");
const npMeta = document.getElementById("npMeta");
const statusPill = document.getElementById("statusPill");
const qcount = document.getElementById("qcount");
const volEl = document.getElementById("vol");

// Hybrid/cloud mode: admin actions need the host token. Ask once, store it.
if (window.NEEDS_AUTH && !localStorage.getItem("host_token")) {
  const t = prompt("Enter host token (set as HOST_TOKEN on the server):", "");
  if (t) localStorage.setItem("host_token", t.trim());
}

async function cmd(action, value) {
  try {
    await api("/api/player/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, value }),
    });
  } catch (e) { toast(e.message); }
  refresh();
}

document.getElementById("play").onclick = () => cmd("play");
document.getElementById("pause").onclick = () => cmd("pause");
document.getElementById("next").onclick = () => cmd("next");
document.getElementById("stop").onclick = () => cmd("stop");
volEl.oninput = () => cmd("volume", parseFloat(volEl.value));

document.getElementById("reindex").onclick = async () => {
  try {
    const r = await api("/api/reindex", { method: "POST" });
    toast(`Indexed ${r.count} songs`);
  } catch (e) {
    // hybrid cloud has no /api/reindex — songs sync from the laptop agent
    toast("Songs sync from the laptop agent");
  }
  refresh();
};

function setNow(state) {
  const c = state.current;
  if (c) {
    nowEl.classList.remove("idle");
    npTitle.textContent = c.title;
    npMeta.innerHTML = (c.artist || "Unknown") + ' · <span class="singer">🎤 ' + c.singer + "</span>";
  } else {
    nowEl.classList.add("idle");
    npTitle.textContent = "Nothing playing";
    npMeta.textContent = "Press play to start the queue";
  }
  statusPill.textContent = state.status;
  statusPill.className = "statuspill " + state.status;
  nowEl.classList.toggle("paused", state.status !== "playing");
}

async function refresh() {
  let state, items;
  try {
    [state, items] = await Promise.all([
      api("/api/player/state"),
      api("/api/queue"),
    ]);
  } catch (e) { return; }

  setNow(state);
  if (document.activeElement !== volEl) volEl.value = state.volume;

  const waiting = items.filter((i) => i.status === "waiting").length;
  qcount.textContent = waiting ? `(${waiting} waiting)` : "";

  queueEl.innerHTML = "";
  if (!items.length) {
    queueEl.innerHTML = '<div class="empty">Queue is empty.</div>';
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
    div.querySelector(".artist").textContent = (it.artist || "Unknown") + " · 🎤 " + it.singer;

    if (!playing) {
      const top = document.createElement("button");
      top.className = "btn btn-ghost btn-icon";
      top.title = "Move to top"; top.textContent = "↑";
      top.onclick = async () => { await api(`/api/queue/${it.id}/top`, { method: "POST" }); refresh(); };
      div.appendChild(top);
    }
    const del = document.createElement("button");
    del.className = "btn btn-danger btn-icon";
    del.title = "Remove"; del.textContent = "✕";
    del.onclick = async (e) => {
      const card = e.target.closest(".card");
      card.classList.add("removing");
      await api(`/api/queue/${it.id}`, { method: "DELETE" });
      setTimeout(refresh, 280);
    };
    div.appendChild(del);
    queueEl.appendChild(div);
  });
}

refresh();
setInterval(refresh, 3000);
