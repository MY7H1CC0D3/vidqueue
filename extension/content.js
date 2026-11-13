/* Page scanner: finds video URLs in the page itself (player config, packed
 * scripts, <video> tags, og:video) so a video can be detected without
 * pressing play. Network-level detection lives in background.js. */
(() => {
  if (window.__vidqueueLoaded) return;
  window.__vidqueueLoaded = true;

  const URL_RE = /https?:(?:\\?\/){2}[^\s"'<>()`]+?\.(?:m3u8|mpd|mp4|webm)(?:\?[^\s"'<>()`]*)?(?=[\s"'<>()`,;]|$)/gi;

  /** Decode Dean Edwards p,a,c,k,e,d packed scripts without eval. */
  function unpackAll(txt) {
    const out = [];
    if (!txt.includes("p,a,c,k,e")) return out;
    const re = /\}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\s*\.split\(\s*'\|'\s*\)/g;
    for (const m of txt.matchAll(re)) {
      try {
        const payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
        const radix = +m[2];
        const words = m[4].split("|");
        const decode = (w) => {
          let n = 0;
          for (const ch of w) {
            const c = ch.charCodeAt(0);
            let v;
            if (c >= 48 && c <= 57) v = c - 48;
            else if (c >= 97 && c <= 122) v = c - 87;
            else if (c >= 65 && c <= 90) v = c - 29;
            else return -1;
            if (v >= radix) return -1;
            n = n * radix + v;
          }
          return n;
        };
        out.push(payload.replace(/\b\w+\b/g, (w) => {
          const i = decode(w);
          return i >= 0 && i < words.length && words[i] ? words[i] : w;
        }));
      } catch (e) { /* ignore malformed */ }
    }
    return out;
  }

  async function scan() {
    const settings = await vqSettings().catch(() => VQ_DEFAULTS);
    const found = new Map();
    const add = (raw) => {
      if (!raw) return;
      let u;
      try {
        u = new URL(String(raw).replace(/\\\//g, "/").replace(/\\u0026/gi, "&"), location.href).href;
      } catch (e) { return; }
      const kind = vqClassify(u, "");
      if (kind) found.set(u, kind);
    };

    for (const v of document.querySelectorAll("video")) {
      if (v.duration && isFinite(v.duration) && v.duration < settings.minDuration) continue;
      add(v.currentSrc); add(v.getAttribute("src"));
      v.querySelectorAll("source[src]").forEach((s) => add(s.src));
    }
    for (const sc of document.scripts) {
      if (sc.src) continue;
      const txt = sc.textContent;
      if (!txt || txt.length > 3e6) continue;
      for (const m of txt.matchAll(URL_RE)) add(m[0]);
      for (const un of unpackAll(txt)) for (const m of un.matchAll(URL_RE)) add(m[0]);
    }
    document.querySelectorAll(
      'meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"]'
    ).forEach((m) => add(m.content));

    if (found.size) {
      browser.runtime.sendMessage({
        type: "pageMedia",
        items: [...found].map(([url, kind]) => ({ url, kind })),
      }).catch(() => {});
    }
  }

  /** Links inside the current selection that look like video tiles. */
  function selectionLinks() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed) return [];
    const here = location.href.split("#")[0];
    const out = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      if (!sel.containsNode(a, true)) continue;
      const href = a.href.split("#")[0];
      if (!/^https?:/.test(href) || href === here) continue;
      if (vqSite(href) !== vqSite(here)) continue;
      const tile = a.querySelector("img,video,picture") ||
        /\b[a-z]{2,6}-?\d{2,5}\b/i.test(a.textContent || "");
      if (tile) out.add(href);
    }
    return [...out];
  }

  /** Try to start playback (muted) so players that only load on play reveal their stream. */
  function kick() {
    const vids = [...document.querySelectorAll("video")]
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    const v = vids[0];
    if (v) {
      v.muted = true;
      v.play().catch(() => {});
    }
    const btn = document.querySelector(
      '.plyr__control--overlaid, .vjs-big-play-button, .jw-icon-display, [aria-label="Play"], button.play, .play-button'
    );
    if (btn) btn.click();
    setTimeout(scan, 1500);
  }

  /** Fetch with the page's own origin/referrer (hls playlists often check them). */
  async function pageFetch(url) {
    // Firefox exposes the page-principal fetch as the content-script global `content`.
    // eslint-disable-next-line no-undef
    const f = (typeof content !== "undefined" && content && typeof content.fetch === "function")
      ? content.fetch.bind(content) : fetch;
    const r = await f(url, { credentials: "include", cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "scan") { scan(); return Promise.resolve(true); }
    if (msg.type === "kick") { kick(); return Promise.resolve(true); }
    if (msg.type === "selectionLinks") return Promise.resolve(selectionLinks());
    if (msg.type === "fetchText") return pageFetch(msg.url).then((text) => ({ text }), (e) => ({ error: String(e) }));
    return false;
  });

  scan();
  setTimeout(scan, 3000);
  setTimeout(scan, 8000);
})();
