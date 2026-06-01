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
const KIND_ICON = { video: "🎬", cdg: "🎤", audio: "🎵" };

// Deterministic "cover art": a unique gradient per song (hashed from name),
// so every track gets its own colourful thumbnail without any network calls.
function coverStyle(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const h1 = h % 360;
  const h2 = (h1 + 40 + (h >> 5) % 120) % 360;
  return `background-image:linear-gradient(135deg,hsl(${h1} 78% 58%),hsl(${h2} 82% 42%));`;
}

// Build a cover thumbnail element for a song.
function coverEl(song) {
  const d = document.createElement("div");
  d.className = "cover";
  d.style.cssText = coverStyle((song.artist || "") + (song.title || ""));
  d.textContent = KIND_ICON[song.kind] || "🎵";
  return d;
}

// ---- PWA: register service worker + handle the install button ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.getElementById("installBtn");
  if (btn) {
    btn.classList.add("show");
    btn.onclick = async () => {
      btn.classList.remove("show");
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    };
  }
});
window.addEventListener("appinstalled", () => {
  const btn = document.getElementById("installBtn");
  if (btn) btn.classList.remove("show");
});
