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
  const bits = [it.kind === "hls" ? "HLS" : it.kind === "dash" ? "DASH" : "File"];
  if (it.height) bits.push(it.height + "p");
  if (it.duration) bits.push(vqFmtTime(it.duration));
  if (it.size) bits.push(vqFmtBytes(it.size));
  if (it.variants) bits.push(it.variants + " qualities");
  if (it.pending) bits.push("checking…");
  if (it.drm) bits.push("DRM - can't download");
  if (it.live) bits.push("live");
  if (it.hidden) bits.push({ short: "too short", small: "too small", variant: "quality variant", invalid: "not a playlist" }[it.hidden] || it.hidden);
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
  $("items").replaceChildren(...(list.length
    ? list.map((it) => itemRow(it, it.id === d.bestId))
    : [el("div", "none", "No video detected yet. Press play on the video, or click Rescan.")]));
}

// DOM building: page-derived URLs are only ever set as text, never as markup
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function itemRow(it, best) {
  const row = el("div", "item" + (best ? " best" : "") + (it.hidden || it.drm || it.live ? " hid" : ""));
  row.append(el("span", "t", describe(it) + (best ? " · best" : "")));
  const btn = el("button", null, "Queue");
  btn.dataset.id = it.id;
  btn.disabled = !!it.drm;
  row.append(btn);
  const u = el("span", "u", `${vqSite(it.url)} · ${it.url.split("?")[0].split("/").slice(-2).join("/")}`);
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

(async () => {
  const forced = new URLSearchParams(location.search).get("tabId"); // popup.html?tabId=N (opened as a page)
  if (forced) tabId = +forced;
  else {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    tabId = tab.id;
  }
  await refresh();
  setInterval(refresh, 1500);
})();
