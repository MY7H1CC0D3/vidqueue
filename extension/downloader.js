/* VidQueue browser download engine.
 *
 * The app decides WHAT runs WHEN (per-site limits); Firefox does the actual
 * fetching through its own network stack and the user's verified session, so
 * Cloudflare-protected CDNs see the real browser. Bytes are streamed to the
 * app, which stores them and merges HLS with ffmpeg.
 *
 * Loaded in the background page after common.js and background.js.
 */

const active = new Map();      // jobId -> { ctl: AbortController, job }
const pendingUrls = new Map(); // url -> job   (requests we're about to send)
const reqJob = new Map();      // requestId -> job (follows redirects)
const OWN_ORIGIN = browser.runtime.getURL("").replace(/\/$/, "");

class Cancelled extends Error {
  constructor() { super("cancelled"); this.cancelled = true; }
}

// ------------------------------------------------ header/cookie injection
function domainMatch(host, domain) {
  const d = domain.replace(/^\./, "").toLowerCase();
  return host === d || host.endsWith("." + d);
}

function mergeCookies(existing, cookies, url) {
  let u;
  try { u = new URL(url); } catch (e) { return existing; }
  const have = new Set((existing || "").split(";").map((p) => p.split("=")[0].trim()).filter(Boolean));
  const add = [];
  for (const c of cookies || []) {
    if (!c || have.has(c.name)) continue;
    if (c.hostOnly ? u.hostname !== c.domain.replace(/^\./, "") : !domainMatch(u.hostname, c.domain)) continue;
    if (c.path && !u.pathname.startsWith(c.path)) continue;
    if (c.secure && u.protocol !== "https:") continue;
    have.add(c.name);
    add.push(`${c.name}=${c.value}`);
  }
  return [existing, ...add].filter(Boolean).join("; ");
}

browser.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    if (d.tabId !== -1) return;
    if (d.originUrl && !d.originUrl.startsWith(OWN_ORIGIN)) return;
    let job = reqJob.get(d.requestId);
    if (!job) {
      job = pendingUrls.get(d.url);
      if (!job) return;
      reqJob.set(d.requestId, job);
    }
    const H = job.headers || {};
    const out = [];
    let cookie = "";
    for (const h of d.requestHeaders) {
      const n = h.name.toLowerCase();
      if (n === "referer" || n === "origin" || n.startsWith("sec-fetch-")) continue;
      if (n === "cookie") { cookie = h.value; continue; }
      out.push(h);
    }
    if (H.Referer) out.push({ name: "Referer", value: H.Referer });
    if (H.Origin) {
      // look like the page's own player (hls.js XHR)
      out.push({ name: "Origin", value: H.Origin });
      out.push({ name: "Sec-Fetch-Dest", value: "empty" });
      out.push({ name: "Sec-Fetch-Mode", value: "cors" });
      out.push({ name: "Sec-Fetch-Site", value: "cross-site" });
    }
    const merged = mergeCookies(cookie, job.cookies, d.url);
    if (merged) out.push({ name: "Cookie", value: merged });
    return { requestHeaders: out };
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestHeaders"]
);
const forgetReq = (d) => reqJob.delete(d.requestId);
browser.webRequest.onCompleted.addListener(forgetReq, { urls: ["<all_urls>"] });
browser.webRequest.onErrorOccurred.addListener(forgetReq, { urls: ["<all_urls>"] });

/** fetch() as the page would, with the job's Referer/Origin/cookies injected. */
async function jfetch(job, url, signal, headers) {
  pendingUrls.set(url, job);
  try {
    return await fetch(url, { credentials: "include", cache: "no-store", signal, headers: headers || {} });
  } finally {
    if (pendingUrls.get(url) === job) pendingUrls.delete(url);
  }
}

const shortUrl = (u) => u.split("?")[0].split("/").slice(-2).join("/");

async function getText(job, url, signal) {
  return new TextDecoder().decode(await getBuf(job, url, signal));
}

async function getBuf(job, url, signal) {
  let last;
  for (let i = 0; i < 5; i++) {
    if (signal.aborted) throw new Cancelled();
    try {
      const r = await jfetch(job, url, signal);
      if (!r.ok) {
        const err = new Error(`HTTP ${r.status} for ${shortUrl(url)}`);
        err.status = r.status;
        throw err;
      }
      return await r.arrayBuffer();
    } catch (e) {
      if (signal.aborted) throw new Cancelled();
      last = e;
      if ((e.status === 403 || e.status === 404 || e.status === 410) && i >= 1) break;
      await sleep(1000 * 2 ** i);
    }
  }
  throw last;
}

async function upload(path, buf, signal) {
  let r;
  try {
    r = await fetch(VQ_API + path, {
      method: "POST",
      headers: { "X-VidQueue": "1", "Content-Type": "application/octet-stream" },
      body: buf,
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw new Cancelled();
    throw new Error("could not reach the VidQueue app");
  }
  if (r.status === 409) throw new Cancelled();
  if (!r.ok) throw new Error("app rejected upload: HTTP " + r.status);
  return r.json();
}

async function appCall(path, body) {
  try {
    return await vqApi(path, body);
  } catch (e) {
    if (/not running/.test(e.message)) throw new Cancelled();
    throw e;
  }
}

// ------------------------------------------------------------------ HLS
function attrs(line) {
  const out = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

function pickVariant(text, base) {
  const lines = text.split(/\r?\n/);
  const audio = {};
  const vars = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith("#EXT-X-MEDIA:")) {
      const a = attrs(l);
      if (a.TYPE === "AUDIO" && a.URI) {
        const g = (audio[a["GROUP-ID"]] = audio[a["GROUP-ID"]] || []);
        g.push({ url: new URL(a.URI, base).href, def: a.DEFAULT === "YES" });
      }
    } else if (l.startsWith("#EXT-X-STREAM-INF")) {
      const a = attrs(l);
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith("#"))) j++;
      if (j >= lines.length) continue;
      const res = /(\d+)x(\d+)/.exec(a.RESOLUTION || "");
      vars.push({
        url: new URL(lines[j].trim(), base).href,
        height: res ? +res[2] : 0,
        bw: +(a.BANDWIDTH || 0),
        audio: a.AUDIO || null,
      });
    }
  }
  vars.sort((x, y) => y.height - x.height || y.bw - x.bw);
  const best = vars[0];
  if (!best) throw new Error("master playlist has no variants");
  let audioUrl = null;
  if (best.audio && audio[best.audio]) {
    const g = audio[best.audio];
    audioUrl = (g.find((x) => x.def) || g[0]).url;
  }
  return { url: best.url, height: best.height || null, audioUrl };
}

const SEG_EXT = /\.(ts|m4s|mp4|aac|m4a|m4v|mp3)$/i;

function rewritePlaylist(text, base, track, resources, byUrl) {
  const out = [];
  let n = 0;
  const nameFor = (rawUrl, kind) => {
    if (rawUrl.startsWith("data:")) return rawUrl;
    const url = new URL(rawUrl, base).href;
    if (byUrl.has(url)) return byUrl.get(url);
    const ext = kind === "key" ? ".key" : kind === "map" ? ".mp4"
      : ((SEG_EXT.exec(new URL(url).pathname) || [".ts"])[0]).toLowerCase();
    const name = `${track[0]}${String(++n).padStart(5, "0")}${ext}`;
    byUrl.set(url, name);
    resources.push({ name, url });
    return name;
  };
  if (!/#EXT-X-ENDLIST/.test(text)) throw new Error("live stream (no end) - not supported");
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("#")) {
      if (/^#EXT-X-BYTERANGE/i.test(l) || (/^#EXT-X-MAP/i.test(l) && /BYTERANGE=/i.test(l))) {
        throw new Error("byte-range HLS is not supported yet");
      }
      if (/^#EXT-X-(?:SESSION-)?KEY/i.test(l)) {
        if (/METHOD=SAMPLE-AES/i.test(l) || /KEYFORMAT="(?!identity")/i.test(l)) throw new Error("DRM-protected stream");
        out.push(l.replace(/URI="([^"]+)"/, (m, u) => `URI="${nameFor(u, "key")}"`));
      } else if (/^#EXT-X-MAP/i.test(l)) {
        out.push(l.replace(/URI="([^"]+)"/, (m, u) => `URI="${nameFor(u, "map")}"`));
      } else {
        out.push(l);
      }
      continue;
    }
    out.push(nameFor(l, "seg"));
  }
  return out.join("\n") + "\n";
}

async function runHls(job, signal) {
  let url = job.media_url;
  let text = await getText(job, url, signal);
  if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("not an HLS playlist (" + shortUrl(url) + ")");
  let height = job.height || null;
  let audioUrl = null;
  if (/#EXT-X-STREAM-INF/.test(text)) {
    const v = pickVariant(text, url);
    url = v.url;
    height = v.height || height;
    audioUrl = v.audioUrl;
    text = await getText(job, url, signal);
  }
  const resources = [];
  const byUrl = new Map();
  const tracks = [{ name: "video", playlist: rewritePlaylist(text, url, "video", resources, byUrl) }];
  if (audioUrl) {
    const at = await getText(job, audioUrl, signal);
    tracks.push({ name: "audio", playlist: rewritePlaylist(at, audioUrl, "audio", resources, byUrl) });
  }
  const plan = await appCall(`/api/browser/${job.id}/plan`, {
    mode: "hls", height, tracks, resources: resources.map((r) => ({ name: r.name })),
  });
  const have = new Set(plan.have || []);
  const todo = resources.filter((r) => !have.has(r.name));
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < todo.length) {
      const r = todo[next++];
      try {
        const buf = await getBuf(job, r.url, signal);
        await upload(`/api/browser/${job.id}/res/${r.name}`, buf, signal);
      } catch (e) {
        failure = failure || e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(job.threads || 4, 16)) }, worker));
  if (failure) throw failure;
}

// ---------------------------------------------------------------- direct
function concat(chunks, len) {
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

async function runDirect(job, signal) {
  const plan = await appCall(`/api/browser/${job.id}/plan`, { mode: "direct" });
  let offset = plan.have_bytes || 0;
  let last = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await jfetch(job, job.media_url, signal, offset ? { Range: `bytes=${offset}-` } : {});
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${shortUrl(job.media_url)}`);
      if (offset && r.status !== 206) offset = 0; // server ignored Range -> restart
      let total = 0;
      const m = /\/(\d+)\s*$/.exec(r.headers.get("content-range") || "");
      if (m) total = +m[1];
      else if (r.headers.get("content-length")) total = offset + +r.headers.get("content-length");
      const reader = r.body.getReader();
      let chunks = [], len = 0;
      const flush = async () => {
        if (!len) return;
        const body = concat(chunks, len);
        chunks = []; len = 0;
        const res = await upload(`/api/browser/${job.id}/chunk?offset=${offset}&total=${total}`, body, signal);
        offset = res.have_bytes;
        if (!res.ok) throw new Error("resume offset mismatch");
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); len += value.byteLength;
        if (len >= 8 * 1048576) await flush();
      }
      await flush();
      if (total && offset < total) throw new Error("connection closed early");
      return;
    } catch (e) {
      if (signal.aborted || e.cancelled) throw new Cancelled();
      last = e;
      await sleep(2000 * (attempt + 1));
    }
  }
  throw last || new Error("download failed");
}

// ------------------------------------------------------------ job runner
async function runJob(job) {
  const ctl = new AbortController();
  active.set(job.id, { ctl, job });
  try {
    if (job.kind === "hls") await runHls(job, ctl.signal);
    else if (job.kind === "direct") await runDirect(job, ctl.signal);
    else throw new Error("unsupported stream type: " + job.kind);
    await appCall(`/api/browser/${job.id}/finish`, {});
  } catch (e) {
    if (!ctl.signal.aborted && !e.cancelled) {
      await vqApi(`/api/browser/${job.id}/fail`, { error: String((e && e.message) || e) }).catch(() => {});
    }
  } finally {
    active.delete(job.id);
  }
}

async function workerLoop() {
  try {
    const r = await vqApi("/api/browser/poll", { active: [...active.keys()] });
    for (const id of r.cancel || []) {
      const a = active.get(id);
      if (a) a.ctl.abort();
    }
    for (const job of r.assign || []) if (!active.has(job.id)) runJob(job);
  } catch (e) { /* app offline */ }
  setTimeout(workerLoop, 2000);
}
workerLoop();
