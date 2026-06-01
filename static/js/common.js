// Shared helpers (loaded inline by each page's script via copy; kept tiny).
function toast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 1800);
}

async function api(url, opts) {
  opts = opts || {};
  // Attach the host token (set on the admin page) to every request; harmless
  // when none is configured (offline LAN mode / guest pages).
  const token = localStorage.getItem("host_token");
  if (token) {
    opts.headers = Object.assign({ "X-Host-Token": token }, opts.headers || {});
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    localStorage.removeItem("host_token");
    throw new Error("Unauthorized — wrong host token");
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
}

const KIND_LABEL = { video: "Video", cdg: "MP3+G", audio: "Audio" };
