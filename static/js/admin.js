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

// Hybrid/cloud mode: admin actions need a token. Ask once, store it. Either
// the host token (full control) or a staff token (view + arrange the queue
// only) works here — the role check below figures out which was entered.
if (window.NEEDS_AUTH && !localStorage.getItem("host_token")) {
  const t = prompt("Enter host or staff token:", "");
  if (t) localStorage.setItem("host_token", t.trim());
}

// "host" (full control), "staff" (queue view/arrange only), or "none" (bad
// token) — resolved once at load, before the first render, so the UI never
// flashes host controls that then have to be hidden.
let ROLE = "host";

async function resolveRole() {
  if (!window.NEEDS_AUTH) return; // dev mode, no tokens configured at all
  try {
    const r = await api("/api/admin/role");
    ROLE = r.role;
  } catch (e) {
    // Wrong/expired token — clear it and ask again rather than getting
    // stuck silently unable to do anything.
    localStorage.removeItem("host_token");
    const t = prompt("Token not recognized. Enter host or staff token:", "");
    if (t) {
      localStorage.setItem("host_token", t.trim());
      return resolveRole();
    }
    ROLE = "none";
  }
  if (ROLE !== "host") {
    document.querySelector(".transport").style.display = "none";
    document.querySelector(".seek-row").style.display = "none";
  }
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

let _draggingReorder = false;
let _refreshBusy = false;

async function refresh() {
  // refresh() is now called from several places close together (a drop, a
  // delete, the periodic timer) — without this, two overlapping calls could
  // interleave: one clearing #queue and rebuilding it while another is
  // still mid-way through appending its own cards, producing duplicated/
  // ghosted-looking entries. At most one refresh runs at a time.
  if (_refreshBusy) return;
  _refreshBusy = true;
  try {
    await _refresh();
  } finally {
    _refreshBusy = false;
  }
}

async function _refresh() {
  clearTimeout(_refreshTimer);
  // A drag rebuilds nothing mid-gesture — a refresh landing here would tear
  // out the very element the pointer is holding.
  if (_draggingReorder) {
    _refreshTimer = setTimeout(refresh, 3000);
    return;
  }
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
    div.dataset.qid = it.id;
    div.innerHTML = `
      <div class="pos">${playing ? "▶" : i}</div>
      <div class="meta"><div class="title"></div><div class="artist"></div></div>`;
    div.children[0].after(coverEl(it));
    div.querySelector(".title").textContent = it.title;
    div.querySelector(".artist").textContent = (it.artist || "Unknown") + " · 🎤 " + it.singer;

    if (!playing) {
      const handle = document.createElement("div");
      handle.className = "drag-handle";
      handle.title = "Drag to reorder";
      handle.textContent = "⠿";
      div.appendChild(handle);
      handle.addEventListener("pointerdown", (e) => startDrag(e, div, handle));
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

// Pointer-based drag reorder (unifies mouse + touch) — dragging a card past
// a neighbor's midpoint swaps their DOM position live; on release, the
// resulting order is sent as a whole to /api/queue/reorder.
function startDrag(e, card, handle) {
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  _draggingReorder = true;
  card.classList.add("dragging");

  function onMove(ev) {
    card.style.transform = `translateY(${ev.clientY - e.clientY}px)`;
    // At most ONE reorder per event: a fast (especially touch) drag can
    // cross several items' midpoints before a single pointermove fires, and
    // checking every sibling in one pass — each check against a DOM that
    // the previous check just mutated — could cascade into multiple moves
    // per event, which is what caused the erratic jumping. Only ever
    // apply the first applicable move; the next event continues it.
    const siblings = [...queueEl.querySelectorAll(".queue-item:not(.playing)")]
      .filter((el) => el !== card);
    for (const sib of siblings) {
      const r = sib.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      const cardIsBefore = !!(card.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (cardIsBefore && ev.clientY > mid) {
        queueEl.insertBefore(card, sib.nextSibling);
        break;
      } else if (!cardIsBefore && ev.clientY < mid) {
        queueEl.insertBefore(card, sib);
        break;
      }
    }
  }

  async function onUp() {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    card.style.transform = "";
    card.classList.remove("dragging");
    const order = [...queueEl.querySelectorAll(".queue-item:not(.playing)")]
      .map((el) => parseInt(el.dataset.qid, 10));
    _draggingReorder = false;
    try {
      await api("/api/queue/reorder", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order }),
      });
    } catch (err) { toast(err.message); }
    refresh();
  }

  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

resolveRole().then(refresh);
