/* VidQueue background: network-level video detection, ranking, job building,
 * link/selection queuing, download-folder session state, notifications. */

const tabsState = new Map(); // tabId -> { items: Map(url -> item), children: Set(url) }
let sessionDir = null;       // per-session folder override (lives until Firefox closes)
let seq = 0;

function tabState(tabId) {
  let s = tabsState.get(tabId);
  if (!s) {
    s = { items: new Map(), children: new Set() };
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
      tabsState.set(d.tabId, { items: new Map(), children: new Set() });
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
    if (kind !== "direct") { /* leave null */ }
    else if (m) size = +m[1];
    else if (d.statusCode === 200) {
      const cl = header(d.responseHeaders, "content-length");
      if (cl) size = +cl;
    }
    addItem(d.tabId, {
      url: d.url, kind, size, source: "network",
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
        url: it.url, kind: it.kind, size: null, source: "page",
        docUrl: sender.url, frameId: sender.frameId || 0,
      });
    }
    return false;
  }
  const h = handlers[msg.type];
  return h ? h(msg, sender) : false;
});

browser.tabs.onRemoved.addListener((id) => tabsState.delete(id));

async function addItem(tabId, it) {
  const st = tabState(tabId);
  const existing = st.items.get(it.url);
  if (existing) {
    if (it.size && !existing.size) existing.size = it.size;
    if (it.source === "network") existing.source = "network";
    return;
  }
  const item = {
    id: ++seq, ...it, ts: Date.now(), height: null, duration: null,
    master: false, variants: 0, live: false, drm: false, hidden: null, pending: true,
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
    for (const v of vars) {
      st.children.add(v.url);
      const c = st.items.get(v.url);
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
const kindScore = (it) => (it.kind === "hls" ? (it.master ? 4 : 3) : it.kind === "dash" ? 3 : 2);

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
  return [...st.items.values()].filter((i) => !i.hidden && !i.drm && !i.live).sort(compareItems);
}

function pickBest(tabId) {
  const st = tabsState.get(tabId);
  if (!st || [...st.items.values()].some((i) => i.pending)) return null;
  return visibleItems(tabId)[0] || null;
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

async function buildJob(item, pageUrl, title) {
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
    const st = tabsState.get(msg.tabId);
    const items = st ? [...st.items.values()].sort(compareItems) : [];
    const best = pickBest(msg.tabId);
    let app = null;
    try { app = await vqApi("/api/status"); } catch (e) { /* offline */ }
    const { pending = [] } = await browser.storage.local.get("pending");
    return {
      items, bestId: best ? best.id : null,
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
    return enqueue([await buildJob(item, tab.url, tab.title)]);
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
  pickDir: (msg) => pickDir(msg.scope),
  async ensureApp() { return { ok: await ensureApp("popup") }; },
  async clearSessionDir() { sessionDir = null; return true; },
  async setSessionDir(msg) { sessionDir = msg.path || null; return true; },
};

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

// ----------------------------------------------------- status notifications
const lastStatus = new Map();
async function poll() {
  try {
    const d = await vqApi("/api/status");
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
  } catch (e) { /* app offline */ }
}
setInterval(poll, 4000);
ensureApp("firefox-start").then(poll);

function notify(title, message) {
  browser.notifications.create({ type: "basic", iconUrl: "icons/icon.svg", title, message: String(message || "") }).catch(() => {});
}
