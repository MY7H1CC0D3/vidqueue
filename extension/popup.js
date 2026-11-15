let tabId = null;
let showHidden = false;
const $ = (id) => document.getElementById(id);
const send = (m) => browser.runtime.sendMessage(m);

function flash(text, err) {
  $("msg").textContent = text;
  $("msg").className = err ? "err" : "";
  setTimeout(() => { if ($("msg").textContent === text) $("msg").textContent = ""; }, 4000);
}

function describe(it) {
  if (it.kind === "page") return `${it.post.site} ${it.post.label} · video + audio (via yt-dlp)` + (it.hidden ? " · earlier page" : "");
  const bits = [it.kind === "hls" ? "HLS" : it.kind === "dash" ? "DASH" : "File"];
  if (it.height) bits.push(it.height + "p");
  if (it.duration) bits.push(vqFmtTime(it.duration));
  if (it.size) bits.push(vqFmtBytes(it.size));
  if (it.variants) bits.push(it.variants + " qualities");
  if (it.pending) bits.push("checking…");
  if (it.drm) bits.push("DRM - can't download");
  if (it.live) bits.push("live");
  if (it.hidden) bits.push({ short: "too short", small: "too small", variant: "quality variant", track: "video-only / audio-only track", poststream: "raw stream (queue the post instead)", invalid: "not a playlist", stale: "earlier page" }[it.hidden] || it.hidden);
  return bits.join(" · ");
}

async function refresh() {
  const d = await send({ type: "getTab", tabId });
  const app = $("app");
  if (d.app) {
    app.className = "pill up";
    app.textContent = `● ${d.app.running} downloading · ${d.app.queued} queued` + (d.app.failed ? ` · ${d.app.failed} failed` : "");
  } else {
    app.className = "pill down";
    app.textContent = "● VidQueue app not running" + (d.pending ? ` (${d.pending} held)` : "");
  }
  $("startApp").hidden = !!d.app;
  $("dash").hidden = !d.app;

  $("dir").textContent = d.folder.dir || "(app default: Downloads\\VidQueue)";
  $("scope").textContent = d.folder.scope === "session" ? "this session" : d.folder.scope === "default" ? "default" : "not set";
  $("scope").className = "tag " + d.folder.scope;
  $("resetSession").hidden = !d.sessionDir;

  const visible = d.items.filter((i) => !i.hidden && !i.drm && !i.live);
  const hidden = d.items.length - visible.length;
  $("count").textContent = visible.length ? `(${visible.length})` : "";
  $("showHiddenWrap").hidden = !hidden;
  $("hiddenCount").textContent = hidden;
  $("queueBest").disabled = !d.bestId;
  $("queueBest").dataset.id = d.bestId || "";

  const list = showHidden ? d.items : visible;
  // rebuild only when something shown changed (keeps previews from flickering)
  const sig = JSON.stringify([d.bestId, list.map((it) => [it.id, describe(it), !!it.thumb, !!it.match])]);
  if (sig === lastSig) { // same rows: just swap in refreshed previews
    for (const it of list) {
      const img = it.thumb && document.querySelector(`.item[data-id="${it.id}"] .thumb img`);
      if (img && img.src !== it.thumb) img.src = it.thumb;
    }
    return;
  }
  lastSig = sig;
  $("items").replaceChildren(...(list.length
    ? list.map((it) => itemRow(it, it.id === d.bestId))
    : [el("div", "none", "No video detected yet. Press play on the video, or click Rescan.")]));
}
let lastSig = "";

// DOM building: page-derived URLs are only ever set as text, never as markup
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function itemRow(it, best) {
  const row = el("div", "item" + (best ? " best" : "") + (it.hidden || it.drm || it.live ? " hid" : ""));
  row.dataset.id = it.id;
  const th = el("div", "thumb" + (it.match ? " found" : ""));
  if (it.thumb) {
    const img = el("img");
    img.src = it.thumb; // data: URL or the player's poster URL (set as a property, never as markup)
    img.alt = "";
    th.append(img);
  } else {
    th.append(el("span", null, it.kind === "hls" ? "HLS" : it.kind === "dash" ? "DASH" : it.kind === "page" ? "POST" : "FILE"));
  }
  th.title = it.match ? "Show this video on the page" : "No matching player found on the page";
  row.append(th);
  row.append(el("span", "t", describe(it) + (best ? " · best" : "")));
  const btn = el("button", null, "Queue");
  btn.dataset.id = it.id;
  btn.disabled = !!it.drm;
  row.append(btn);
  const u = el("span", "u", `${vqSite(it.url)} · ${it.kind === "page" ? it.post.label + " " + it.post.code : it.url.split("?")[0].split("/").slice(-2).join("/")}`);
  u.title = it.url;
  row.append(u);
  return row;
}

async function queue(itemId) {
  const r = await send({ type: "queueItem", tabId, itemId: +itemId });
  if (r && r.ok) flash("Queued ✓");
  else if (r && r.held) flash("App not running. Held until it starts.", true);
  else flash("Couldn't queue that one.", true);
  refresh();
}

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (t.matches(".item button")) return queue(t.dataset.id);
  const th = t.closest(".thumb.found");
  if (th) return send({ type: "highlight", tabId, itemId: +th.closest(".item").dataset.id, on: true, reveal: true });
  if (t.id === "queueBest" && t.dataset.id) return queue(t.dataset.id);
  if (t.id === "pickSession" || t.id === "pickDefault") {
    flash("Folder picker opened (it may be behind Firefox)…");
    send({ type: "pickDir", scope: t.id === "pickSession" ? "session" : "default" });
    return;
  }
  if (t.id === "resetSession") { await send({ type: "clearSessionDir" }); return refresh(); }
  if (t.id === "rescan") { e.preventDefault(); await send({ type: "rescan", tabId }); flash("Rescanning…"); setTimeout(refresh, 2000); return; }
  if (t.id === "queuePage") {
    e.preventDefault();
    const r = await send({ type: "queuePage", tabId });
    flash(r && r.ok ? "Page link queued ✓" : "App not running. Held until it starts.", !(r && r.ok));
    return refresh();
  }
  if (t.id === "dash") { e.preventDefault(); browser.tabs.create({ url: VQ_API + "/" }); window.close(); }
  if (t.id === "startApp") {
    t.disabled = true; t.textContent = "Starting…";
    const r = await send({ type: "ensureApp" });
    t.disabled = false; t.textContent = "Start VidQueue";
    if (!r || !r.ok) flash("Couldn't start VidQueue. Is it installed?", true);
    return refresh();
  }
  if (t.id === "about") { e.preventDefault(); browser.tabs.create({ url: VQ_API + "/#about" }); window.close(); }
  if (t.id === "opts") { e.preventDefault(); browser.runtime.openOptionsPage(); window.close(); }
});

$("showHidden").addEventListener("change", (e) => { showHidden = e.target.checked; refresh(); });

// Hovering a row outlines its player on the page.
let hovered = null;
document.addEventListener("mouseover", (e) => {
  const row = e.target.closest && e.target.closest(".item");
  const id = row ? +row.dataset.id : null;
  if (id === hovered) return;
  hovered = id;
  send({ type: "highlight", tabId, itemId: id, on: !!id }).catch(() => {});
});
document.addEventListener("mouseleave", () => {
  hovered = null;
  send({ type: "highlight", tabId, on: false }).catch(() => {});
});

(async () => {
  const forced = new URLSearchParams(location.search).get("tabId"); // popup.html?tabId=N (opened as a page)
  if (forced) tabId = +forced;
  else {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    tabId = tab.id;
  }
  browser.runtime.connect({ name: "popup:" + tabId }); // background clears the outline when the popup closes
  await refresh();
  setInterval(refresh, 1500);
})();
