/* VidQueue background: network-level video detection, ranking, job building,
 * link/selection queuing, download-folder session state, notifications. */

const tabsState = new Map(); // tabId -> { items: Map(url -> item), children: Set(url), videos: Map(frameId -> report) }
let sessionDir = null;       // per-session folder override (lives until Firefox closes)
let seq = 0;

const newTabState = () => ({
  items: new Map(), children: new Set(), videos: new Map(), askedAt: 0,
  seen: new Set(),       // every player (frameId:vid) reported on this page
  posterTok: new Map(),  // distinctive URL token -> poster URL, for players X has since removed
  path: null,
  postPage: null,        // canonical URL of the Instagram/Facebook post or video on screen
});

function tabState(tabId) {
  let s = tabsState.get(tabId);
  if (!s) {
    s = newTabState();
    tabsState.set(tabId, s);
  }
  return s;
}

const header = (hs, name) => {
  const h = (hs || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ detection
browser.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId >= 0) {
      tabsState.set(d.tabId, newTabState());
      updateBadge(d.tabId);
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

browser.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    const kind = vqClassify(d.url, header(d.responseHeaders, "content-type"));
    if (!kind) return;
    let size = null; // only meaningful for direct files (playlist size is not the video size)
    const cr = header(d.responseHeaders, "content-range");
    const m = cr && /\/(\d+)\s*$/.exec(cr);
    const url = vqNormUrl(d.url);
    if (kind !== "direct") { /* leave null */ }
    else if (m) size = +m[1];
    else if (url !== d.url) { /* a ?bytestart= piece (Instagram answers 200): its length is not the file's */ }
    else if (d.statusCode === 200) {
      const cl = header(d.responseHeaders, "content-length");
      if (cl) size = +cl;
    }
    addItem(d.tabId, {
      url, kind, size, source: "network",
      docUrl: d.documentUrl || d.originUrl || null, frameId: d.frameId || 0,
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other", "object"] },
  ["responseHeaders"]
);

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "pageMedia" && sender.tab) {
    for (const it of msg.items || []) {
      addItem(sender.tab.id, {
        url: vqNormUrl(it.url), kind: it.kind, size: null, source: "page",
        docUrl: sender.url, frameId: sender.frameId || 0,
      });
    }
    return false;
  }
  if (msg.type === "videos" && sender.tab) {
    const st = tabState(sender.tab.id);
    const frameId = sender.frameId || 0;
    st.videos.set(frameId, { list: msg.list || [], vw: msg.vw, vh: msg.vh, at: Date.now() });
    for (const v of msg.list || []) {
      st.seen.add(frameId + ":" + v.vid);
      if (v.poster) for (const t of urlTokens(v.poster)) st.posterTok.set(t, v.poster);
    }
    matchVideos(sender.tab.id);
    return false;
  }
  if (msg.type === "userClick" && sender.tab) { tabState(sender.tab.id).lastClickAt = Date.now(); return false; }
  if (msg.type === "newPlayer" && sender.tab) { autoClear(sender.tab.id); return false; }
  const h = handlers[msg.type];
  return h ? h(msg, sender) : false;
});

browser.tabs.onRemoved.addListener((id) => tabsState.delete(id));

/** Auto-clear (sites in autoClearSites): a big player just started a new video, e.g. an
 *  overlay that opens without changing the URL. Hide everything first seen before the
 *  click that opened it, except streams still being fetched (the new video's own) and
 *  the post on screen. Unlike a manual Clear, an auto-cleared stream comes back if a
 *  playing player turns out to show it. */
async function autoClear(tabId) {
  const now = Date.now();
  const st = tabsState.get(tabId);
  if (!st) return;
  let url;
  try { url = (await browser.tabs.get(tabId)).url; } catch (e) { return; }
  const { autoClearSites } = await vqSettings();
  if (!(autoClearSites || []).includes(vqSite(url))) return;
  const opened = st.lastClickAt && now - st.lastClickAt < 20000 ? st.lastClickAt : now - 2500;
  const cutoff = opened - 1500;
  for (const it of st.items.values()) {
    if (it.cleared || it.url === st.postPage || it.ts >= cutoff) continue;
    if ((it.hits || []).some((h) => h >= cutoff)) continue;
    it.cleared = "auto";
    it.match = null;
  }
  updateBadge(tabId);
}

// Sites like X change pages without loading a new document. When the path
// changes, hide the previous page's streams (anything older than 2 s: the new
// page's player may already have asked for its stream). They come back if a
// player on the new page shows them, since X can reuse an already-loaded video.
const pathKey = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch (e) { return u; } };
browser.tabs.onUpdated.addListener((tabId, ch) => {
  if (!ch.url) return;
  const st = tabsState.get(tabId);
  if (!st) return;
  const post = sitePost(ch.url);
  const p = post ? post.url : pathKey(ch.url);
  if (st.path && st.path !== p) {
    const cutoff = Date.now() - 2000;
    for (const it of st.items.values()) {
      if (it.ts >= cutoff || it.hidden === "stale") continue;
      it.staleHidden = it.hidden;
      it.hidden = "stale";
      it.match = null;
    }
    st.videos.clear(); st.seen.clear(); st.posterTok.clear();
    updateBadge(tabId);
    browser.tabs.sendMessage(tabId, { type: "scan" }).catch(() => {});
  }
  st.path = p;
  syncPostPage(tabId, ch.url);
});

// ------------------------------------------- Instagram / Facebook posts
// These players stream separate video-only/audio-only tracks and preload the
// next reels/videos, so which stream is "the" video can't be told reliably.
// The page URL names the post/video on screen, and yt-dlp's Instagram and
// Facebook extractors download it with audio (using the browser's cookies).
function sitePost(url) {
  let m = /^https:\/\/(?:www\.)?instagram\.com\/(?:[^/?#]+\/)?(p|reels?|tv)\/([A-Za-z0-9_-]{5,})/.exec(url || "");
  if (m) {
    const type = m[1] === "p" ? "p" : m[1] === "tv" ? "tv" : "reel";
    return { site: "Instagram", code: m[2], label: type === "p" ? "post" : "reel", url: `https://www.instagram.com/${type}/${m[2]}/` };
  }
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  if (!/(?:^|\.)facebook\.com$/.test(u.hostname)) return null;
  m = /^\/reel\/(\d{6,})/.exec(u.pathname);
  if (m) return { site: "Facebook", code: m[1], label: "reel", url: `https://www.facebook.com/reel/${m[1]}` };
  const v = (/^\/(?:watch\/?|video\.php)$/.test(u.pathname) && u.searchParams.get("v")) ||
    (/^\/[^/]+\/videos\/(?:[^/]+\/)?(\d{6,})\/?$/.exec(u.pathname) || [])[1];
  if (v && /^\d{6,}$/.test(v)) return { site: "Facebook", code: v, label: "video", url: `https://www.facebook.com/watch/?v=${v}` };
  return null;
}
const isMetaCdn = (u) => /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(vqSite(u));

function syncPostPage(tabId, url) {
  const st = tabState(tabId);
  const p = sitePost(url);
  st.postPage = p ? p.url : null;
  if (!p) return;
  const old = st.items.get(p.url);
  if (old) { if (old.hidden === "stale") old.hidden = null; return; }
  st.items.set(p.url, {
    id: ++seq, url: p.url, kind: "page", source: "page", ts: Date.now(), hits: [], frameId: 0,
    size: null, height: null, duration: null, master: false, variants: 0, live: false, drm: false,
    hidden: null, pending: false, post: p,
  });
  updateBadge(tabId);
}

/** Fallback for a post job if yt-dlp's site extractor fails: the CDN stream
 *  surely matched to the same player (progressive file first, never audio-only). */
function postFallback(st, item) {
  const key = item.match && item.match.key;
  if (!key) return null;
  const c = [...st.items.values()].filter((i) => i.kind === "direct" && isMetaCdn(i.url) && i.hidden !== "stale" &&
    i.match && i.match.key === key && SURE.has(i.match.how) && !(i.fb && i.fb.audio));
  c.sort((a, b) => ((b.fb && b.fb.progressive) - (a.fb && a.fb.progressive)) || (b.size || 0) - (a.size || 0));
  return c[0] || null;
}

/** The player the user is watching: playing on screen, else the biggest one on screen. */
function focusVideo(vids) {
  const on = vids.filter((v) => v.inView && v.w >= 200).sort((a, b) => (b.playing - a.playing) || b.w * b.h - a.w * a.h);
  return on[0] || null;
}

async function addItem(tabId, it) {
  const st = tabState(tabId);
  const existing = st.items.get(it.url);
  if (existing) {
    if (it.size && !existing.size) existing.size = it.size;
    if (it.source === "network") {
      if (existing.source !== "network") existing.ts = Date.now(); // first request, for timing matches
      existing.source = "network";
      existing.hits = [...(existing.hits || []), Date.now()].slice(-40);
    }
    return;
  }
  const item = {
    id: ++seq, ...it, ts: Date.now(), hits: it.source === "network" ? [Date.now()] : [], height: null, duration: null,
    master: false, variants: 0, live: false, drm: false, hidden: null, pending: true,
    fb: fbMeta(it.url),
  };
  st.items.set(it.url, item);
  updateBadge(tabId);
  try {
    const s = await vqSettings();
    if (item.kind === "hls") await enrichHls(tabId, st, item, s);
    else if (item.kind === "direct") {
      if (item.size == null) await probeSize(item);
      if (item.size != null && item.size < s.minSizeMB * 1048576) item.hidden = "small";
    }
    if (!item.height) {
      const hm = /(?:^|[^\d])(2160|1440|1080|720|540|480|360|240)p?(?:[^\d]|$)/i.exec(item.url);
      if (hm) item.height = +hm[1];
    }
  } catch (e) {
    item.error = String(e);
  } finally {
    item.pending = false;
    updateBadge(tabId);
  }
}

async function fetchText(tabId, item, url) {
  // 1) inside the page (correct Origin/Referer/cookies, same as the player).
  //    The player often requests the playlist before our content script is
  //    injected, so retry a few times before giving up on the page context.
  for (let i = 0; i < 4; i++) {
    try {
      const r = await browser.tabs.sendMessage(tabId, { type: "fetchText", url }, { frameId: item.frameId || 0 });
      if (r && r.text != null) return r.text;
      break; // content script answered with an error -> don't retry
    } catch (e) {
      await sleep(1000); // content script not injected yet
    }
  }
  // 2) from the extension
  const r = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}

/** Audio/subtitle renditions (#EXT-X-MEDIA URI=...) of a master playlist. */
function parseRenditions(text, base) {
  const out = [];
  for (const m of text.matchAll(/#EXT-X-MEDIA:[^\n]*URI="([^"]+)"/g)) {
    try { out.push(new URL(m[1], base).href); } catch (e) { /* skip */ }
  }
  return out;
}

function parseMaster(text, base) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(lines[i]);
    const bw = /[^-]BANDWIDTH=(\d+)/i.exec(lines[i]);
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].startsWith("#"))) j++;
    if (j < lines.length) {
      try {
        out.push({ url: new URL(lines[j].trim(), base).href, height: res ? +res[2] : 0, bw: bw ? +bw[1] : 0 });
      } catch (e) { /* skip */ }
    }
  }
  return out;
}

function mediaInfo(t) {
  let duration = 0;
  for (const m of t.matchAll(/#EXTINF:\s*([\d.]+)/g)) duration += parseFloat(m[1]);
  return {
    duration,
    live: !/#EXT-X-ENDLIST/.test(t),
    drm: /#EXT-X-(?:SESSION-)?KEY:[^\n]*(METHOD=SAMPLE-AES|KEYFORMAT="(?:com\.widevine|com\.apple\.streamingkeydelivery|com\.microsoft\.playready|urn:uuid))/i.test(t),
  };
}

async function enrichHls(tabId, st, item, s) {
  const txt = await fetchText(tabId, item, item.url);
  if (!txt.trimStart().startsWith("#EXTM3U")) { item.hidden = "invalid"; return; }
  if (/#EXT-X-STREAM-INF/.test(txt)) {
    item.master = true;
    const vars = parseMaster(txt, item.url).sort((a, b) => b.height - a.height || b.bw - a.bw);
    item.variants = vars.length;
    for (const u of [...vars.map((v) => v.url), ...parseRenditions(txt, item.url)]) {
      st.children.add(u);
      const c = st.items.get(u);
      if (c) c.hidden = "variant";
    }
    if (vars[0]) {
      item.height = vars[0].height || null;
      try { Object.assign(item, mediaInfo(await fetchText(tabId, item, vars[0].url))); } catch (e) { /* ok */ }
    }
  } else {
    Object.assign(item, mediaInfo(txt));
    if (st.children.has(item.url)) item.hidden = "variant";
  }
  if (!item.hidden && !item.live && item.duration && item.duration < s.minDuration) item.hidden = "short";
}

async function probeSize(item) {
  try {
    const r = await fetch(item.url, { method: "HEAD", credentials: "include" });
    const cl = r.headers.get("content-length");
    if (r.ok && cl) item.size = +cl;
  } catch (e) { /* unknown */ }
}

// -------------------------------------------------------------- ranking
const kindScore = (it) => (it.kind === "page" ? 5 : it.kind === "hls" ? (it.master ? 4 : 3) : it.kind === "dash" ? 3 : 2);

function compareItems(a, b) {
  if (a.duration && b.duration) {
    const r = a.duration / b.duration;
    if (r > 1.1) return -1;
    if (r < 0.9) return 1;
  }
  return kindScore(b) - kindScore(a) || (b.height || 0) - (a.height || 0) || (b.size || 0) - (a.size || 0);
}

function visibleItems(tabId) {
  const st = tabsState.get(tabId);
  if (!st) return [];
  return [...st.items.values()].filter((i) => !i.hidden && !i.cleared && !i.drm && !i.live).sort(compareItems);
}

/** The player the user is watching: playing and on screen (largest wins). */
function focusPlayer(st) {
  const on = allVideos(st).filter((v) => v.inView && v.playing).sort((a, b) => b.w * b.h - a.w * a.h);
  return on[0] ? on[0].frameId + ":" + on[0].vid : null;
}

function pickBest(tabId) {
  const st = tabsState.get(tabId);
  const post = st && st.postPage && st.items.get(st.postPage);
  if (post && !post.hidden) return post; // Instagram/Facebook: the post on screen
  if (!st || [...st.items.values()].some((i) => i.pending && !i.cleared)) return null;
  const vis = visibleItems(tabId);
  const focus = focusPlayer(st);
  // pages with several real videos (X threads): the one being watched, not the longest
  const watched = focus && vis.find((i) => i.match && i.match.key === focus);
  return watched || vis[0] || null;
}

// ------------------------------------------------- previews (stream -> player)
// Distinctive URL parts: long numbers (X media ids) or long mixed ids/hashes.
function urlTokens(u) {
  if (!u) return [];
  let path;
  try { const x = new URL(u); path = x.pathname + x.search; } catch (e) { return []; }
  return path.split(/[^A-Za-z0-9]+/).filter((t) =>
    /^\d{6,}$/.test(t) || (t.length >= 10 && /\d/.test(t) && /[a-z]/i.test(t)));
}

function allVideos(st) {
  const out = [];
  for (const [frameId, rep] of st.videos) for (const v of rep.list) out.push({ ...v, frameId, vw: rep.vw });
  return out;
}

const longIds = (toks) => toks.filter((t) => /^\d{10,}$/.test(t));
/** True when both sides carry media ids (X: 19-digit numbers) and none agree. */
function idsConflict(a, b) {
  const x = longIds(a), y = longIds(b);
  return x.length > 0 && y.length > 0 && !x.some((t) => y.includes(t));
}

/** Instagram/Facebook CDN files carry efg=<base64 JSON> naming the asset and the
 *  encoding: the player streams separate video-only/audio-only DASH tracks, while
 *  the page also lists a progressive file (video + audio) of the same asset. */
function fbMeta(url) {
  try {
    // page-scanned copies end in escaped padding (%253D%3D): keep the base64 part
    let e = (/^[A-Za-z0-9+/_-]+/.exec(new URL(url).searchParams.get("efg") || "") || [""])[0];
    if (e.length % 4 === 1) e = e.slice(0, -1);
    if (!e) return null;
    const j = JSON.parse(atob(e.replace(/-/g, "+").replace(/_/g, "/")));
    const asset = j.xpv_asset_id || j.video_id;
    if (!asset) return null;
    const tag = String(j.vencode_tag || "");
    return { asset: String(asset), audio: /audio/i.test(tag), progressive: /progressive/i.test(tag) };
  } catch (e) {
    return null;
  }
}

const SURE = new Set(["src", "id", "fed", "asset", "focus"]);

/** Instagram: one reel = one entry. The progressive file (or failing that the
 *  biggest video track) stays listed and borrows the player its DASH tracks were
 *  matched to; the other tracks fold under it. */
function groupAssets(st) {
  const groups = new Map();
  for (const it of st.items.values()) {
    if (!it.fb || it.hidden === "stale") continue;
    if (!groups.has(it.fb.asset)) groups.set(it.fb.asset, []);
    groups.get(it.fb.asset).push(it);
  }
  for (const list of groups.values()) {
    const vids = list.filter((i) => !i.fb.audio);
    const main = vids.find((i) => i.fb.progressive) || vids.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
    const sure = list.find((i) => i.match && SURE.has(i.match.how) && i.match.how !== "asset");
    if (main && main.hidden === "track") main.hidden = null; // the biggest track changed
    for (const it of list) {
      if (it !== main && (!it.hidden || it.hidden === "small")) it.hidden = "track";
      if (sure && it !== sure && (!it.match || it.match.how === "asset") && (!it.match || it.match.key !== sure.match.key)) {
        it.match = { ...sure.match, how: "asset" };
        it.thumb = sure.thumb || null; it.thumbKind = sure.thumbKind; it.thumbAt = sure.thumbAt || 0;
      }
    }
    // a reel in a real-size player is a real video even when it is under the size filter
    if (main && main.hidden === "small" && main.match && main.match.w >= 200) { main.hidden = null; main.shownSmall = true; }
  }
}

/** Which <video> on the page plays each detected stream (best guess, or none). */
function matchVideos(tabId) {
  const st = tabsState.get(tabId);
  if (!st) return;
  const vids = allVideos(st).map((v) => ({ ...v, toks: [...urlTokens(v.poster), ...urlTokens(v.src)] }));
  const sized = vids.filter((v) => v.w * v.h > 0);
  for (const item of st.items.values()) {
    const toks = item.toks || (item.toks = urlTokens(item.url));
    let pick = null, how = null;
    if (item.kind === "page") {
      if (item.url === st.postPage) { pick = focusVideo(vids); how = pick ? "focus" : null; }
    } else {
    // 1. the player loads this exact file
    pick = vids.find((v) => v.src && v.src.split("#")[0] === item.url.split("#")[0]);
    if (pick) how = "src";
    // 2. shares a distinctive id with the poster or source (X: amplify_video/<id> <-> amplify_video_thumb/<id>)
    if (!pick && toks.length) {
      const scored = vids.map((v) => ({ v, n: new Set(v.toks.filter((t) => toks.includes(t))).size }))
        .filter((x) => x.n).sort((a, b) => b.n - a.n);
      if (scored.length && (scored.length === 1 || scored[0].n > scored[1].n)) { pick = scored[0].v; how = "id"; }
    }
    // 3. MSE players (Instagram): the player whose buffer grows right after this
    //    stream's pieces arrive, clearly more often than any other player's
    if (!pick && item.hits && item.hits.length >= 2) {
      const scored = vids.filter((v) => v.frameId === (item.frameId || 0) && v.fed && v.fed.length && !idsConflict(toks, v.toks))
        .map((v) => ({ v, n: item.hits.filter((h) => v.fed.some((f) => f >= h && f <= h + 1500)).length }))
        .filter((x) => x.n >= 2).sort((a, b) => b.n - a.n);
      if (scored.length && (scored.length === 1 || scored[0].n >= 2 * scored[1].n)) { pick = scored[0].v; how = "fed"; }
    }
    // 4. the player that started loading/playing just before the stream was requested
    if (!pick && item.source === "network") {
      const cands = vids.filter((v) => v.frameId === (item.frameId || 0) && !idsConflict(toks, v.toks)).map((v) => ({
        v, t: Math.max(-Infinity, ...v.events.filter((e) => e <= item.ts + 300 && e >= item.ts - 5000)),
      })).filter((x) => isFinite(x.t)).sort((a, b) => b.t - a.t);
      if (cands.length && (cands.length === 1 || cands[0].t - cands[1].t > 400)) { pick = cands[0].v; how = "timing"; }
    }
    // 5. the page has only ever had one player (not X, which swaps players as you scroll)
    if (!pick && sized.length === 1 && st.seen.size === 1 && !idsConflict(toks, sized[0].toks)) { pick = sized[0]; how = "only"; }
    }

    const key = pick ? pick.frameId + ":" + pick.vid : null;
    const old = item.match;
    if (key !== (old && old.key)) {
      const sure = old && SURE.has(old.how);
      if (pick || !sure) { item.thumb = null; item.thumbAt = 0; } // a confirmed preview outlives its player
      item.match = pick ? { key, frameId: pick.frameId, vid: pick.vid, how, w: pick.w } : null;
    }
    // auto-cleared, but a playing player clearly shows it: it's the video being watched
    if (item.cleared === "auto" && pick && pick.playing && (how === "src" || how === "id")) { item.cleared = false; updateBadge(tabId); }
    // a stream from the previous page that a player here clearly shows is back
    if (item.hidden === "stale" && pick && (how === "src" || how === "id")) item.hidden = item.staleHidden || null;
    // a short clip in a real-size player that is clearly this stream is a real video (X), not an ad
    if (item.hidden === "short" && pick && (how === "src" || how === "id") && pick.w >= 200) {
      item.hidden = null; item.shownShort = true;
    }
    // no player any more: use the poster of the player that once showed this stream
    if (!pick && !item.thumb) {
      const t = toks.find((x) => st.posterTok.has(x));
      if (t) { item.thumb = st.posterTok.get(t); item.thumbKind = "poster"; item.thumbAt = Date.now(); }
    }
  }
  groupAssets(st);
  // on a post/reel page the reel itself is the entry; its CDN streams (often
  // preloads of other reels, video or audio only) fold away
  if (st.postPage) {
    for (const it of st.items.values()) {
      if (isMetaCdn(it.url) && (!it.hidden || it.hidden === "small" || it.hidden === "track")) it.hidden = "poststream";
    }
  }
}

const thumbBusy = new Set();
async function cropScreenshot(tab, rect, vw) {
  const shot = await browser.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
  const img = await createImageBitmap(await (await fetch(shot)).blob());
  const k = img.width / (vw || img.width);
  const sx = Math.max(0, rect.x * k), sy = Math.max(0, rect.y * k);
  const sw = Math.min(img.width - sx, rect.w * k), sh = Math.min(img.height - sy, rect.h * k);
  if (sw < 20 || sh < 20) return null;
  const c = document.createElement("canvas");
  c.width = 192; c.height = Math.max(1, Math.round(192 * sh / sw));
  c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.75);
}

/** Fill in previews for matched streams (refreshing frame grabs every 10 s while the popup is open). */
async function ensureThumbs(tabId) {
  const st = tabsState.get(tabId);
  if (!st || thumbBusy.has(tabId)) return;
  thumbBusy.add(tabId);
  try {
    let tab = null;
    for (const item of st.items.values()) {
      const m = item.match;
      if (!m || (item.thumb && (item.thumbKind !== "frame" || Date.now() - item.thumbAt < 10000))) continue;
      let r = null;
      try { r = await browser.tabs.sendMessage(tabId, { type: "thumb", vid: m.vid }, { frameId: m.frameId }); } catch (e) { /* frame gone */ }
      if (!r || r.gone) continue;
      if (r.data) { item.thumb = r.data; item.thumbKind = "frame"; }
      else if (r.poster) { item.thumb = r.poster; item.thumbKind = "poster"; }
      else if (m.frameId === 0 && r.inView && r.played) { // an unplayed player would just be a black box
        try {
          tab = tab || await browser.tabs.get(tabId);
          if (tab.active) {
            const d = await cropScreenshot(tab, r.rect, r.vw);
            if (d) { item.thumb = d; item.thumbKind = "frame"; }
          }
        } catch (e) { /* screenshot not allowed here */ }
      }
      item.thumbAt = Date.now();
    }
  } finally { thumbBusy.delete(tabId); }
}

function updateBadge(tabId) {
  const n = visibleItems(tabId).length;
  browser.browserAction.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
  browser.browserAction.setBadgeBackgroundColor({ tabId, color: "#2f6fed" }).catch(() => {});
}

// --------------------------------------------------------- job building
async function effectiveDir() {
  const s = await vqSettings();
  return { dir: sessionDir || s.defaultDir || "", scope: sessionDir ? "session" : s.defaultDir ? "default" : "app" };
}

async function collectCookies(urls) {
  const out = [];
  for (const u of urls.filter(Boolean)) {
    let got = [];
    try {
      got = await browser.cookies.getAll({ url: u, firstPartyDomain: null, partitionKey: {} });
    } catch (e) {
      try { got = await browser.cookies.getAll({ url: u }); } catch (e2) { /* none */ }
    }
    for (const c of got) {
      out.push({
        domain: c.domain, hostOnly: c.hostOnly, path: c.path, secure: c.secure,
        expirationDate: c.expirationDate || 0, name: c.name, value: c.value,
      });
    }
  }
  return out;
}

async function buildJob(item, pageUrl, title, fallback) {
  if (item && item.kind === "page") { // Instagram/Facebook post: yt-dlp from its page URL
    const p = item.post;
    const t = vqCleanTitle((title || "").replace(/^\(\d+\+?\)\s*/, ""), p.site.toLowerCase() + ".com");
    const job = await buildJob(fallback || null, item.url, `${t && t.toLowerCase() !== p.site.toLowerCase() ? t : p.site} [${p.code}]`);
    job.engine = "ytdlp"; // site extractor on the page URL first, the matched stream (if any) as fallback
    return job;
  }
  const s = await vqSettings();
  const site = vqSite(pageUrl || (item && (item.docUrl || item.url)));
  let { dir } = await effectiveDir();
  if (dir && s.subfolderPerSite && site) dir = dir.replace(/[\\/]+$/, "") + "\\" + site;
  const referer = (item && item.docUrl) || pageUrl || "";
  const headers = { "User-Agent": navigator.userAgent, Referer: referer };
  if (item && item.kind !== "direct" && referer && vqSite(referer) !== vqSite(item.url)) {
    try { headers.Origin = new URL(referer).origin; } catch (e) { /* skip */ }
  }
  return {
    site,
    page_url: pageUrl || "",
    media_url: item ? item.url : "",
    kind: item ? item.kind : null,
    height: item ? item.height : null,
    engine: s.browserDownload && item && (item.kind === "hls" || item.kind === "direct") ? "browser" : "ytdlp",
    title: vqCleanTitle(title || "", site),
    dir,
    headers,
    cookies: await collectCookies([item && item.url, pageUrl, referer !== pageUrl ? referer : null]),
  };
}

// ---------------------------------------------- sending (with offline buffer)
// --------------------------------------------- starting the app (like VDH)
// Firefox launches VidQueue through native messaging: on Firefox start and
// whenever there's something to send. It is NOT restarted just because it is
// not running (the user may have quit it from the tray).
const NATIVE_HOST = "com.cannontech.vidqueue";
let lastEnsure = 0, lastEnsureFailed = false;

async function appUp() {
  try { await vqApi("/api/ping"); return true; } catch (e) { return false; }
}

async function ensureApp(reason) {
  if (await appUp()) return true;
  if (Date.now() - lastEnsure < (lastEnsureFailed ? 60000 : 5000)) return false;
  lastEnsure = Date.now();
  try {
    const r = await browser.runtime.sendNativeMessage(NATIVE_HOST, { cmd: "ensure", reason });
    lastEnsureFailed = !(r && r.ok);
  } catch (e) {
    lastEnsureFailed = true; // VidQueue not installed / not registered
  }
  return !lastEnsureFailed && appUp();
}

async function enqueue(jobs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await vqApi("/api/jobs", { jobs });
      return { ok: true, added: r.added.length };
    } catch (e) {
      if (attempt === 0 && (await ensureApp("queue"))) continue;
    }
  }
  const { pending = [] } = await browser.storage.local.get("pending");
  pending.push(...jobs);
  await browser.storage.local.set({ pending });
  notify("VidQueue app isn't running",
    `${jobs.length} video(s) held in Firefox. They'll be sent as soon as the VidQueue app runs.`);
  return { ok: false, held: jobs.length };
}

async function flushPending() {
  const { pending = [] } = await browser.storage.local.get("pending");
  if (!pending.length) return;
  if (!(await appUp()) && !(await ensureApp("pending"))) return;
  try {
    await vqApi("/api/jobs", { jobs: pending });
    await browser.storage.local.set({ pending: [] });
    notify("VidQueue", `Sent ${pending.length} held video(s) to the app.`);
  } catch (e) { /* still offline */ }
}

// ----------------------------------------------- queue from link (background tab)
let linkSlots = 0;
const linkWaiters = [];
async function withSlot(fn) {
  while (linkSlots >= 2) await new Promise((r) => linkWaiters.push(r));
  linkSlots++;
  try { return await fn(); } finally {
    linkSlots--;
    const n = linkWaiters.shift();
    if (n) n();
  }
}

function queueFromLink(url, srcTab) {
  return withSlot(async () => {
    const opts = { url, active: false };
    if (srcTab) { opts.windowId = srcTab.windowId; opts.index = srcTab.index + 1; }
    const tab = await browser.tabs.create(opts);
    browser.tabs.update(tab.id, { muted: true }).catch(() => {});
    const start = Date.now();
    let loadedAt = null, kicked = false;
    while (Date.now() - start < 45000) {
      await sleep(1000);
      let t;
      try { t = await browser.tabs.get(tab.id); } catch (e) { return { ok: false }; }
      if (t.status === "complete" && !loadedAt) loadedAt = Date.now();
      const best = pickBest(tab.id);
      if (best && (best.master || (loadedAt && Date.now() - loadedAt > 3000))) {
        const job = await buildJob(best, t.url, t.title);
        browser.tabs.remove(tab.id).catch(() => {});
        return enqueue([job]);
      }
      if (loadedAt && !kicked && Date.now() - loadedAt > 2500) {
        kicked = true;
        browser.tabs.sendMessage(tab.id, { type: "kick" }).catch(() => {});
      }
    }
    notify("VidQueue: no video found", `Couldn't detect a video on ${url} in the background. The tab was left open; play it and use the toolbar button.`);
    return { ok: false };
  });
}

// ---------------------------------------------------------- folder choice
async function pickDir(scope) {
  const cur = await effectiveDir();
  let r;
  try {
    r = await vqApi("/api/pick-folder", { initial: cur.dir });
  } catch (e) {
    notify("VidQueue", "The app must be running to open the folder picker.");
    return { ok: false };
  }
  if (!r.path) return { ok: false };
  if (scope === "session") sessionDir = r.path;
  else await browser.storage.local.set({ defaultDir: r.path });
  notify("VidQueue", `${scope === "session" ? "This session's" : "Default"} download folder:\n${r.path}`);
  return { ok: true, path: r.path };
}

// --------------------------------------------------------------- handlers
const handlers = {
  async getTab(msg) {
    try { const t = await browser.tabs.get(msg.tabId); if (sitePost(t.url) || tabsState.has(msg.tabId)) syncPostPage(msg.tabId, t.url); } catch (e) { /* tab gone */ }
    const st = tabsState.get(msg.tabId);
    if (st && Date.now() - st.askedAt > 1200) { // players report back via "videos"
      st.askedAt = Date.now();
      browser.tabs.sendMessage(msg.tabId, { type: "reportVideos" }).catch(() => {});
    }
    if (st) { matchVideos(msg.tabId); ensureThumbs(msg.tabId); }
    const items = st ? [...st.items.values()].sort(compareItems).map((i) => (i.cleared ? { ...i, hidden: "cleared" } : i)) : [];
    const best = pickBest(msg.tabId);
    let site = "";
    try { site = vqSite((await browser.tabs.get(msg.tabId)).url); } catch (e) { /* tab gone */ }
    const { autoClearSites = [] } = await vqSettings();
    let app = null;
    try { app = await vqApi("/api/status"); } catch (e) { /* offline */ }
    const { pending = [] } = await browser.storage.local.get("pending");
    return {
      items, bestId: best ? best.id : null, site, autoClear: autoClearSites.includes(site),
      folder: await effectiveDir(), sessionDir, defaultDir: (await vqSettings()).defaultDir,
      app: app && {
        running: app.jobs.filter((j) => j.status === "running").length,
        queued: app.jobs.filter((j) => j.status === "queued").length,
        failed: app.jobs.filter((j) => j.status === "error").length,
        limit: app.settings.per_site_limit,
        ffmpeg: app.ffmpeg,
      },
      pending: pending.length,
    };
  },
  async queueItem(msg) {
    const tab = await browser.tabs.get(msg.tabId);
    const st = tabsState.get(msg.tabId);
    const item = st && [...st.items.values()].find((i) => i.id === msg.itemId);
    if (!item) return { ok: false };
    return enqueue([await buildJob(item, tab.url, tab.title, item.kind === "page" ? postFallback(st, item) : null)]);
  },
  async queuePage(msg) {
    const tab = await browser.tabs.get(msg.tabId);
    return enqueue([await buildJob(null, tab.url, tab.title)]);
  },
  async rescan(msg) {
    await browser.tabs.sendMessage(msg.tabId, { type: "scan" }).catch(() => {});
    await browser.tabs.sendMessage(msg.tabId, { type: "kick" }).catch(() => {});
    return true;
  },
  /** "Clear": hide everything found on this tab so far (earlier pages, ads, old variants).
   *  Items are kept (marked cleared) rather than deleted, so a rescan or the page's own
   *  scripts finding the same URL again doesn't bring it back; only streams first seen
   *  after the click show up. Cleared ones stay reachable under "show filtered".
   *  The Instagram/Facebook post on screen is the page itself, so it stays. */
  async setAutoClear(msg) {
    const { autoClearSites = [] } = await vqSettings();
    const list = autoClearSites.filter((s) => s !== msg.site);
    if (msg.on && msg.site) list.push(msg.site);
    await browser.storage.local.set({ autoClearSites: list });
    return true;
  },
  async clearTab(msg) {
    const st = tabsState.get(msg.tabId);
    if (!st) return true;
    for (const it of st.items.values()) {
      if (it.url === st.postPage) continue;
      it.cleared = true;
      it.match = null;
    }
    updateBadge(msg.tabId);
    await browser.tabs.sendMessage(msg.tabId, { type: "highlight", on: false }).catch(() => {});
    return true;
  },
  async highlight(msg) {
    const st = tabsState.get(msg.tabId);
    const item = st && [...st.items.values()].find((i) => i.id === msg.itemId);
    const m = item && item.match;
    if (msg.on && !m) return false;
    // turn off everywhere first (the lit player may be in another frame)
    await browser.tabs.sendMessage(msg.tabId, { type: "highlight", on: false }).catch(() => {});
    if (msg.on) {
      await browser.tabs.sendMessage(msg.tabId, { type: "highlight", vid: m.vid, on: true, reveal: !!msg.reveal }, { frameId: m.frameId }).catch(() => {});
    }
    return true;
  },
  pickDir: (msg) => pickDir(msg.scope),
  async ensureApp() { return { ok: await ensureApp("popup") }; },
  async clearSessionDir() { sessionDir = null; return true; },
  async setSessionDir(msg) { sessionDir = msg.path || null; return true; },
};

browser.runtime.onConnect.addListener((port) => {
  const m = /^popup:(\d+)$/.exec(port.name);
  if (m) port.onDisconnect.addListener(() => {
    browser.tabs.sendMessage(+m[1], { type: "highlight", on: false }).catch(() => {});
  });
});

// ------------------------------------------------------------ context menus
browser.menus.create({ id: "vq-link", title: "VidQueue: queue video from this link", contexts: ["link"] });
browser.menus.create({ id: "vq-sel", title: "VidQueue: queue all video links in selection", contexts: ["selection"] });
browser.menus.create({ id: "vq-page", title: "VidQueue: queue best video on this page", contexts: ["page", "video"] });

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "vq-link") {
    notify("VidQueue", "Finding the video on that page…");
    queueFromLink(info.linkUrl, tab);
  } else if (info.menuItemId === "vq-sel") {
    let links = [];
    try { links = await browser.tabs.sendMessage(tab.id, { type: "selectionLinks" }, { frameId: info.frameId || 0 }); } catch (e) { /* none */ }
    if (!links.length) return notify("VidQueue", "No video links found in the selection.");
    notify("VidQueue", `Queuing ${links.length} video(s) from the selection. Up to 2 background tabs open at a time.`);
    for (const l of links) queueFromLink(l, tab);
  } else if (info.menuItemId === "vq-page") {
    const best = pickBest(tab.id);
    if (!best) return notify("VidQueue", "No video detected on this page yet. Press play and try again.");
    const r = await enqueue([await buildJob(best, tab.url, tab.title)]);
    if (r.ok) notify("VidQueue", "Queued: " + vqCleanTitle(tab.title, vqSite(tab.url)));
  }
});

// ------------------------------------------------- settings backup in the app
// Firefox wipes an add-on's storage when it is removed and reinstalled (or a test copy is
// unloaded), which used to lose the download folder. The app keeps a copy in
// %LOCALAPPDATA%\VidQueue\extension-settings.json; empty storage is filled back from it.
const VQ_KEYS = Object.keys(VQ_DEFAULTS);
let settingsSynced = false, settingsDirty = false;
async function syncSettings() {
  try {
    if (!settingsSynced) {
      const local = await browser.storage.local.get(VQ_KEYS);
      if (!Object.keys(local).length) { // nothing stored: fresh install or wiped storage
        const { settings } = await vqApi("/api/ext-settings", {});
        const saved = {};
        for (const k of VQ_KEYS) if (settings && k in settings) saved[k] = settings[k];
        settingsSynced = true;
        if (Object.keys(saved).length) await browser.storage.local.set(saved);
        return;
      }
      settingsSynced = true;
      settingsDirty = true; // storage is the newer copy: back it up
    }
    if (settingsDirty) {
      settingsDirty = false;
      await vqApi("/api/ext-settings", { settings: await browser.storage.local.get(VQ_KEYS) });
    }
  } catch (e) {
    if (settingsSynced) settingsDirty = true; // app offline: poll() retries
  }
}
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !VQ_KEYS.some((k) => k in changes)) return;
  settingsDirty = true;
  if (settingsSynced) syncSettings();
});

// --------------------------------------------- follow the app's version
// The app's "Update now" can't touch Firefox add-ons, and Firefox only checks for add-on
// updates about once a day. When the app is newer than this add-on, ask Firefox to check now.
let updateAskedAt = 0, updateReady = false;
function vqNewer(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}
async function checkAddonUpdate(appVersion) {
  if (updateReady) return applyAddonUpdate();
  if (!appVersion || !vqNewer(appVersion, browser.runtime.getManifest().version)) return;
  if (Date.now() - updateAskedAt < 30 * 60 * 1000) return; // at most every 30 minutes
  updateAskedAt = Date.now();
  try { await browser.runtime.requestUpdateCheck(); } catch (e) { /* no update_url / offline */ }
}
// Firefox has downloaded the new version: restart into it once no browser download is running
// (reloading would abort them).
function applyAddonUpdate() {
  if (typeof active !== "undefined" && active.size) return;
  browser.runtime.reload();
}
browser.runtime.onUpdateAvailable.addListener(() => { updateReady = true; applyAddonUpdate(); });
browser.runtime.onInstalled.addListener((d) => {
  if (d.reason === "update" && d.previousVersion !== browser.runtime.getManifest().version) {
    notify("VidQueue add-on updated", `Now version ${browser.runtime.getManifest().version}.`);
  }
});

// ----------------------------------------------------- status notifications
const lastStatus = new Map();
async function poll() {
  try {
    const d = await vqApi("/api/status");
    checkAddonUpdate(d.version);
    const s = await vqSettings();
    for (const j of d.jobs) {
      const prev = lastStatus.get(j.id);
      if (prev && prev !== j.status && s.notify) {
        if (j.status === "done") notify("Downloaded", j.title || j.filename || j.page_url);
        else if (j.status === "error") notify("Download failed", (j.title || j.page_url) + "\n" + (j.error || "").slice(0, 150));
      }
      lastStatus.set(j.id, j.status);
    }
    await flushPending();
    await syncSettings();
  } catch (e) { /* app offline */ }
}
setInterval(poll, 4000);
ensureApp("firefox-start").then(poll);

function notify(title, message) {
  browser.notifications.create({ type: "basic", iconUrl: "icons/icon.svg", title, message: String(message || "") }).catch(() => {});
}
