/* Shared helpers: loaded in background, popup, options and content scripts. */
const VQ_API = "http://127.0.0.1:9666";

const VQ_DEFAULTS = {
  defaultDir: "",          // empty = app fallback (~/Downloads/VidQueue)
  subfolderPerSite: false, // save into <dir>\<site>\
  minDuration: 60,         // hide HLS/DASH streams shorter than this (seconds) - ads, previews
  minSizeMB: 5,            // hide direct files smaller than this
  notify: true,            // desktop notifications on finish/fail
  browserDownload: true,   // Firefox fetches HLS/direct streams itself (needed for Cloudflare CDNs)
};

async function vqApi(path, body) {
  const r = await fetch(VQ_API + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-VidQueue": "1", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
  return data;
}

function vqSettings() {
  return browser.storage.local.get(VQ_DEFAULTS);
}

function vqSite(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

const VQ_MEDIA_EXT = /\.(mp4|webm|mkv|flv|mov|m4v|avi|wmv)$/i;
const VQ_SKIP_EXT = /\.(ts|m4s|aac|m4a|mp3|vtt|srt|key|jpe?g|png|gif|webp|svg|js|css|html?)$/i;

/** One URL per file: drop byte-range query params (Instagram/Facebook CDNs fetch
 *  a file as many ?bytestart=&byteend= pieces; without them the whole file comes back). */
function vqNormUrl(url) {
  if (!/[?&]byte(?:start|end)=/.test(url)) return url;
  try {
    const u = new URL(url);
    u.searchParams.delete("bytestart");
    u.searchParams.delete("byteend");
    return u.href;
  } catch (e) {
    return url;
  }
}

/** Returns "hls" | "dash" | "direct" | null for a URL + content-type. */
function vqClassify(url, contentType) {
  const ct = (contentType || "").toLowerCase().split(";")[0].trim();
  let path;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    path = u.pathname.toLowerCase();
  } catch (e) {
    return null;
  }
  if (ct.startsWith("text/html") || ct.startsWith("image/")) return null;
  if (path.endsWith("/dash_mpd_debug.mpd")) return null; // Facebook-internal, not a real manifest
  if (ct.includes("mpegurl") || path.endsWith(".m3u8")) return "hls";
  if (ct === "application/dash+xml" || path.endsWith(".mpd")) return "dash";
  if (ct === "video/mp2t" || ct === "video/iso.segment" || VQ_SKIP_EXT.test(path)) return null;
  if (ct.startsWith("video/") || VQ_MEDIA_EXT.test(path)) return "direct";
  return null;
}

/** "ABC-123 Some Title - SiteName | Free videos" -> "ABC-123 Some Title" */
function vqCleanTitle(title, site) {
  let t = (title || "").replace(/\s+/g, " ").trim();
  const base = (site.split(".").slice(-2, -1)[0] || site).toLowerCase();
  if (!base) return t;
  const parts = t.split(/\s+[-|–—]\s+/);
  const norm = (s) => s.toLowerCase().replace(/[\s._-]/g, "");
  const idx = parts.findIndex((p, i) => i > 0 && norm(p).includes(base));
  if (idx > 0) t = parts.slice(0, idx).join(" - ");
  return t.trim();
}

function vqFmtBytes(b) {
  if (!b) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < 4) { b /= 1024; i++; }
  return b.toFixed(i > 1 ? 1 : 0) + " " + u[i];
}

function vqFmtTime(s) {
  if (s == null || !isFinite(s)) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
}
