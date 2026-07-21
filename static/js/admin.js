const queueEl = document.getElementById("queue");
const nowEl = document.getElementById("nowPlaying");
const npTitle = document.getElementById("npTitle");
const npMeta = document.getElementById("npMeta");
const statusPill = document.getElementById("statusPill");
const qcount = document.getElementById("qcount");
const volEl = document.getElementById("vol");
const seekEl = document.getElementById("seek");
const seekTimeEl = document.getElementById("seekTime");
const connBanner = document.getElementById("connBanner");

let _dur = 0, _pos = 0, _dragging = false, _ticker = null;
let _connected = false, _refreshTimer = null;

function fmt(s) {
  s = Math.max(0, Math.floor(s || 0));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

seekEl.addEventListener("mousedown",  () => { _dragging = true; });
seekEl.addEventListener("touchstart", () => { _dragging = true; }, { passive: true });
seekEl.addEventListener("input", () => {
  if (!_dur) return;
  const p = (parseFloat(seekEl.value) / 100) * _dur;
  seekTimeEl.textContent = fmt(p) + " / " + fmt(_dur);
});
seekEl.addEventListener("change", () => {
  _dragging = false;
  if (!_dur) return;
  cmd("seek", (parseFloat(seekEl.value) / 100) * _dur);
});
seekEl.addEventListener("mouseup",  () => { _dragging = false; });
seekEl.addEventListener("touchend", () => { _dragging = false; });

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
document.getElementById("restart").onclick = () => cmd("restart");
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

  // Seek bar
  if (!_dragging) {
    _dur = state.duration || 0;
    _pos = state.position || 0;
    seekEl.disabled = !c || !_dur;
    seekEl.value = _dur ? (_pos / _dur) * 100 : 0;
    seekTimeEl.textContent = fmt(_pos) + " / " + fmt(_dur);
  }
  clearInterval(_ticker);
  if (state.status === "playing" && c && _dur) {
    _ticker = setInterval(() => {
      if (_dragging) return;
      _pos = Math.min(_pos + 1, _dur);
      seekEl.value = (_pos / _dur) * 100;
      seekTimeEl.textContent = fmt(_pos) + " / " + fmt(_dur);
    }, 1000);
  }
}

async function refresh() {
  clearTimeout(_refreshTimer);
  let state, items;
  try {
    [state, items] = await Promise.all([
      api("/api/player/state"),
      api("/api/queue"),
    ]);
  } catch (e) {
    // Free-tier Render can take up to ~60s to wake from idle — the first
    // request(s) can outlive our short per-call timeout. Show that we're
    // still trying instead of leaving stale/empty panels with no feedback,
    // and retry quickly rather than waiting out the normal 3s cadence.
    connBanner.style.display = _connected ? "none" : "";
    _refreshTimer = setTimeout(refresh, 1500);
    return;
  }
  _connected = true;
  connBanner.style.display = "none";

  setNow(state);
  if (document.activeElement !== volEl) volEl.value = state.volume;

  const waitingItems = items.filter((i) => i.status === "waiting");
  qcount.textContent = waitingItems.length ? `(${waitingItems.length} waiting)` : "";

  queueEl.innerHTML = "";
  if (!items.length) {
    queueEl.innerHTML = '<div class="empty">Queue is empty.</div>';
    _refreshTimer = setTimeout(refresh, 3000);
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
      const waitIdx = waitingItems.indexOf(it);

      const up = document.createElement("button");
      up.className = "btn btn-ghost btn-icon";
      up.title = "Move up"; up.textContent = "↑";
      up.disabled = waitIdx <= 0;
      up.onclick = async () => {
        await api(`/api/queue/${it.id}/move`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ direction: "up" }),
        });
        refresh();
      };
      div.appendChild(up);

      const down = document.createElement("button");
      down.className = "btn btn-ghost btn-icon";
      down.title = "Move down"; down.textContent = "↓";
      down.disabled = waitIdx === waitingItems.length - 1;
      down.onclick = async () => {
        await api(`/api/queue/${it.id}/move`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ direction: "down" }),
        });
        refresh();
      };
      div.appendChild(down);

      const top = document.createElement("button");
      top.className = "btn btn-ghost btn-icon";
      top.title = "Move to top"; top.textContent = "⤒";
      top.disabled = waitIdx <= 0;
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
  _refreshTimer = setTimeout(refresh, 3000);
}

refresh();
