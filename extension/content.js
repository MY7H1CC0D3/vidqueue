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
        // JSON/HTML escapes: \/ , & and &amp; are "&", and an embedded DASH
        // manifest ends a URL with </BaseURL (escaped "<")
        const s = String(raw).replace(/\\\//g, "/").replace(/\\u0026|&amp;/gi, "&").replace(/\\u003c[\s\S]*$/i, "");
        u = vqNormUrl(new URL(s, location.href).href);
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

  // ------------------------------------------------ players (popup previews)
  // Each <video> gets a stable id, and we remember when it started loading or
  // playing, so the background can tell which player asked for which stream.
  const vidIds = new WeakMap();
  const vidEvents = new WeakMap(); // video -> recent event timestamps
  let nextVid = 0;
  const vidOf = (v) => {
    if (!vidIds.has(v)) vidIds.set(v, ++nextVid);
    return vidIds.get(v);
  };
  const byVid = (id) => [...document.querySelectorAll("video")].find((v) => vidIds.get(v) === id);
  // MSE players (Instagram: blob: src, no poster) can only be told apart by
  // when their buffer grows: "progress" fires as each fetched piece is appended.
  const vidFed = new WeakMap(); // video -> recent progress timestamps
  document.addEventListener("progress", (e) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !/^blob:/.test(v.currentSrc || "")) return;
    vidOf(v);
    const list = vidFed.get(v) || [];
    list.push(Date.now());
    vidFed.set(v, list.slice(-40));
    soonReport();
  }, true);
  for (const ev of ["loadstart", "play", "playing", "seeking"]) {
    document.addEventListener(ev, (e) => {
      const v = e.target;
      if (!(v instanceof HTMLVideoElement)) return;
      vidOf(v);
      const list = vidEvents.get(v) || [];
      list.push(Date.now());
      // keep the first events (when it started loading) as well as the latest:
      // a player that stalls a lot would otherwise push its loadstart out
      vidEvents.set(v, list.length > 16 ? [...list.slice(0, 4), ...list.slice(-12)] : list);
      soonReport();
    }, true);
  }
  // Report players as they appear and play, not only when the popup opens:
  // X removes players scrolled out of view, and their posters are what lets
  // the popup show the right preview for those streams later.
  let reportTimer = null;
  const soonReport = () => {
    if (!reportTimer) reportTimer = setTimeout(() => { reportTimer = null; reportVideos(); }, 1000);
  };
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && (n.tagName === "VIDEO" || (n.firstElementChild && n.querySelector("video")))) return soonReport();
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  // Auto-clear (per-site option): tell the background when a big player starts
  // playing a new source, e.g. an overlay that opens without changing the URL.
  // The background hides what was found before the click that opened it.
  let lastMainSrc = null, lastClickSent = 0;
  document.addEventListener("pointerdown", () => {
    const now = Date.now();
    if (now - lastClickSent < 500) return;
    lastClickSent = now;
    browser.runtime.sendMessage({ type: "userClick" }).catch(() => {});
  }, true);
  document.addEventListener("playing", (e) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    const r = v.getBoundingClientRect();
    const big = r.width >= 320 && r.height >= 180 && r.width * r.height >= 0.12 * innerWidth * innerHeight;
    const src = v.currentSrc || v.getAttribute("src") || "";
    if (!big || !src || src === lastMainSrc) return;
    lastMainSrc = src;
    browser.runtime.sendMessage({ type: "newPlayer" }).catch(() => {});
  }, true);
  const plainSrc = (v) => {
    const s = v.currentSrc || v.getAttribute("src") || "";
    return /^https?:/.test(s) ? s : "";
  };

  function reportVideos() {
    if (!document.querySelector("video")) return;
    const vw = innerWidth, vh = innerHeight;
    const list = [...document.querySelectorAll("video")].map((v) => {
      const r = v.getBoundingClientRect();
      return {
        vid: vidOf(v),
        poster: v.poster || "",
        src: plainSrc(v),
        events: vidEvents.get(v) || [],
        fed: vidFed.get(v) || [],
        playing: !v.paused && !v.ended && v.currentTime > 0,
        time: v.currentTime || 0,
        w: Math.round(r.width), h: Math.round(r.height),
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        inView: r.width > 40 && r.height > 30 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw,
      };
    });
    browser.runtime.sendMessage({ type: "videos", list, vw, vh }).catch(() => {});
  }

  /** Small preview of one player: a frame grab, else its poster, else where it is on screen. */
  function thumb(id) {
    const v = byVid(id);
    if (!v) return { gone: true };
    const r = v.getBoundingClientRect();
    const where = {
      poster: v.poster || "",
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      vw: innerWidth,
      played: v.currentTime > 0,
      inView: r.width > 40 && r.bottom > 0 && r.top < innerHeight,
    };
    if (v.currentTime < 0.2 && v.poster) return where; // nothing decoded yet, the poster is better
    if (v.readyState >= 2 && v.videoWidth) {
      try {
        const c = document.createElement("canvas");
        c.width = 192;
        c.height = Math.max(1, Math.round(192 * v.videoHeight / v.videoWidth));
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        return { ...where, data: c.toDataURL("image/jpeg", 0.75) };
      } catch (e) { /* cross-origin video without CORS: canvas is tainted */ }
    }
    return where;
  }

  let lit = null;
  function highlight(id, on, reveal) {
    if (lit) { lit.el.style.outline = lit.outline; lit.el.style.outlineOffset = lit.offset; lit = null; }
    const v = on && byVid(id);
    if (!v) return;
    lit = { el: v, outline: v.style.outline, offset: v.style.outlineOffset };
    v.style.outline = "4px solid #2f6fed";
    v.style.outlineOffset = "-4px";
    if (reveal) v.scrollIntoView({ behavior: "smooth", block: "center" });
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
    if (msg.type === "reportVideos") { if (document.querySelector("video")) reportVideos(); return false; }
    if (msg.type === "thumb") return byVid(msg.vid) ? Promise.resolve(thumb(msg.vid)) : false;
    if (msg.type === "highlight") { highlight(msg.vid, msg.on, msg.reveal); return false; }
    return false;
  });

  scan();
  setTimeout(scan, 3000);
  setTimeout(scan, 8000);
})();
