const $ = (id) => document.getElementById(id);
const APP_KEYS = ["per_site_limit", "global_limit", "max_attempts", "fragment_threads"];
let appUp = false;

function status(text, ok) {
  $("status").textContent = text;
  $("status").className = "status " + (ok ? "ok" : "err");
}

async function load() {
  const s = await vqSettings();
  $("defaultDir").value = s.defaultDir;
  $("subfolderPerSite").checked = s.subfolderPerSite;
  $("minDuration").value = s.minDuration;
  $("minSizeMB").value = s.minSizeMB;
  $("notify").checked = s.notify;
  $("browserDownload").checked = s.browserDownload;
  const tab = await browser.runtime.sendMessage({ type: "getTab", tabId: -1 });
  $("sessionDir").value = tab.sessionDir || "";
  try {
    const d = await vqApi("/api/status");
    appUp = true;
    for (const k of APP_KEYS) $(k).value = d.settings[k];
    $("check_updates").checked = d.settings.check_updates !== false;
    $("site_limits").value = Object.entries(d.settings.site_limits || {}).map(([k, v]) => `${k} = ${v}`).join("\n");
    $("appState").textContent = `App connected (v${d.version})` + (d.ffmpeg ? "" : " - ffmpeg NOT found");
  } catch (e) {
    appUp = false;
    APP_KEYS.forEach((k) => ($(k).disabled = true));
    $("site_limits").disabled = true;
    $("check_updates").disabled = true;
    $("appState").textContent = "VidQueue app not running. Start it to edit these.";
  }
}

async function save() {
  await browser.storage.local.set({
    defaultDir: $("defaultDir").value.trim(),
    subfolderPerSite: $("subfolderPerSite").checked,
    minDuration: Math.max(0, +$("minDuration").value || 0),
    minSizeMB: Math.max(0, +$("minSizeMB").value || 0),
    notify: $("notify").checked,
    browserDownload: $("browserDownload").checked,
  });
  await browser.runtime.sendMessage({ type: "setSessionDir", path: $("sessionDir").value.trim() });
  if (appUp) {
    const body = {};
    for (const k of APP_KEYS) body[k] = Math.max(1, parseInt($(k).value, 10) || 1);
    body.check_updates = $("check_updates").checked;
    body.site_limits = {};
    for (const line of $("site_limits").value.split("\n")) {
      const m = /^\s*([^=\s]+)\s*=\s*(\d+)\s*$/.exec(line);
      if (m) body.site_limits[vqSite("https://" + m[1].replace(/^https?:\/\//, "")) || m[1]] = +m[2];
    }
    try { await vqApi("/api/settings", body); } catch (e) { return status("Saved locally, but the app rejected settings: " + e.message, false); }
  }
  status("Saved ✓", true);
}

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (t.dataset.pick) {
    status("Folder picker opened (it may be behind Firefox)…", true);
    const r = await browser.runtime.sendMessage({ type: "pickDir", scope: t.dataset.pick });
    if (r && r.ok) { await load(); status("Folder set ✓", true); }
    else status(appUp ? "No folder chosen." : "The app must be running for Browse.", false);
  }
  if (t.id === "clearSession") { $("sessionDir").value = ""; await browser.runtime.sendMessage({ type: "clearSessionDir" }); status("Session folder cleared ✓", true); }
  if (t.id === "save") save();
});

load();
