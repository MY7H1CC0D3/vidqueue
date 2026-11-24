"""VidQueue - local download queue with per-site concurrency limits.

Runs a small HTTP server on 127.0.0.1:9666 that the VidQueue Firefox
extension sends jobs to. Downloads are done with yt-dlp (+ ffmpeg for
HLS/DASH remuxing). A dashboard is served at http://127.0.0.1:9666/
"""
import gc
import http.server
import json
import logging
import os
import platform
import re
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

import yt_dlp
from yt_dlp.utils import DownloadCancelled

VERSION = "1.2.3"
PUBLISHER = "Cannon Technologies"
GITHUB_REPO = "MY7H1CC0D3/vidqueue"
HOST, PORT = "127.0.0.1", int(os.environ.get("VIDQUEUE_PORT") or 9666)  # port override for tests
FROZEN = bool(getattr(sys, "frozen", False))
if FROZEN:
    # packaged VidQueue.exe: resources inside the bundle, data per user
    INSTALL_DIR = Path(sys.executable).resolve().parent
    APP_DIR = Path(getattr(sys, "_MEIPASS", INSTALL_DIR))
    BASE = INSTALL_DIR
    DEFAULT_DATA = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "VidQueue"
else:
    APP_DIR = Path(__file__).resolve().parent
    BASE = APP_DIR.parent
    INSTALL_DIR = BASE
    DEFAULT_DATA = BASE / "data"
DATA = Path(os.environ.get("VIDQUEUE_DATA") or DEFAULT_DATA)  # override for tests
DATA.mkdir(parents=True, exist_ok=True)
(DATA / "cookies").mkdir(exist_ok=True)
JOBS_FILE = DATA / "jobs.json"
SETTINGS_FILE = DATA / "settings.json"
EXT_SETTINGS_FILE = DATA / "extension-settings.json"  # backup of the Firefox add-on's options (survives add-on reinstalls)

logging.basicConfig(
    filename=str(DATA / "vidqueue.log"),
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("vidqueue")

DEFAULT_SETTINGS = {
    "per_site_limit": 3,      # max simultaneous downloads from one site
    "global_limit": 9,        # max simultaneous downloads overall
    "site_limits": {},        # {"example.com": 2} overrides
    "max_attempts": 3,        # automatic retries before giving up
    "fragment_threads": 4,    # parallel HLS/DASH fragment downloads per job
    "fallback_dir": str(Path.home() / "Downloads" / "VidQueue"),
    "check_updates": True,    # look for new VidQueue releases on GitHub
    "tray": False,            # tray icon (forced on while Start with Windows is on)
}

lock = threading.RLock()
wake = threading.Event()
jobs: list = []
settings: dict = {}
cancel_flags: dict = {}

PUBLIC_FIELDS = (
    "id", "status", "site", "page_url", "media_url", "kind", "title", "dir",
    "created", "started", "finished", "progress", "downloaded", "total",
    "speed", "eta", "filename", "error", "attempts", "next_try", "height",
    "phase", "method", "engine",
)

# Browser engine: Firefox (the extension) fetches the media through its own,
# already-verified session and streams the bytes here; we store and merge.
browser_state = {"last_poll": 0.0}
BROWSER_LEASE = 45          # seconds without a heartbeat before a job is requeued
NO_WINDOW = 0x08000000 if os.name == "nt" else 0
_res_name = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def default_engine(job):
    return "browser" if job.get("media_url") and job.get("kind") in ("hls", "direct") else "ytdlp"


def browser_connected():
    return time.time() - browser_state["last_poll"] < 10


# ---------------------------------------------------------------- helpers
def find_ffmpeg():
    bundled = INSTALL_DIR / "ffmpeg" / "ffmpeg.exe"
    if bundled.exists():
        return str(bundled.parent)
    local = os.environ.get("LOCALAPPDATA", "")
    pk = Path(local) / "Microsoft" / "WinGet" / "Packages"
    if pk.exists():
        for f in pk.glob("Gyan.FFmpeg*/**/bin/ffmpeg.exe"):
            return str(f.parent)
    p = shutil.which("ffmpeg")
    if p:
        return str(Path(p).resolve().parent)
    return None


FFMPEG = find_ffmpeg()


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path, obj):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def save_jobs():
    with lock:
        save_json(JOBS_FILE, jobs)


def save_settings():
    with lock:
        save_json(SETTINGS_FILE, settings)


_bad = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_name(title: str) -> str:
    t = _bad.sub(" ", title or "").strip()
    t = re.sub(r"\s+", " ", t).strip(" .")
    if not t:
        t = "video-" + time.strftime("%Y%m%d-%H%M%S")
    if len(t) > 150:
        t = t[:150].rstrip(" .")
    if t.upper() in {"CON", "PRN", "AUX", "NUL"} or re.fullmatch(r"(?i)(COM|LPT)\d", t):
        t = "_" + t
    return t


def site_key(url_or_host: str) -> str:
    h = url_or_host
    m = re.match(r"^[a-z]+://([^/:]+)", url_or_host, re.I)
    if m:
        h = m.group(1)
    h = h.lower()
    if h.startswith("www."):
        h = h[4:]
    return h


_extractors = None


def specific_extractor(url: str):
    """Name of a dedicated (non-generic) yt-dlp extractor for url, if any."""
    global _extractors
    if not url:
        return None
    if _extractors is None:
        _extractors = [
            ie for ie in yt_dlp.extractor.gen_extractor_classes()
            if ie.ie_key() != "Generic" and getattr(ie, "_WORKING", True)
        ]
    for ie in _extractors:
        try:
            if ie.suitable(url):
                return ie.ie_key()
        except Exception:
            pass
    return None


def write_cookiefile(job) -> str | None:
    cookies = job.get("cookies") or []
    if not cookies:
        return None
    path = DATA / "cookies" / f"{job['id']}.txt"
    lines = ["# Netscape HTTP Cookie File"]
    seen = set()
    for c in cookies:
        try:
            domain = c["domain"]
            host_only = c.get("hostOnly", not domain.startswith("."))
            if not host_only and not domain.startswith("."):
                domain = "." + domain
            key = (domain, c.get("path", "/"), c["name"])
            if key in seen:
                continue
            seen.add(key)
            lines.append("\t".join([
                domain,
                "FALSE" if host_only else "TRUE",
                c.get("path", "/"),
                "TRUE" if c.get("secure") else "FALSE",
                str(int(c.get("expirationDate") or 0)),
                c["name"],
                str(c.get("value", "")),
            ]))
        except Exception:
            continue
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(path)


def public(job):
    return {k: job.get(k) for k in PUBLIC_FIELDS}


# ------------------------------------------------------------- downloading
class JobLogger:
    def __init__(self, job):
        self.job = job

    def debug(self, msg):
        if msg.startswith("[download] Destination:"):
            self.job["filename"] = msg.split(":", 1)[1].strip()

    def info(self, msg):
        pass

    def warning(self, msg):
        log.warning("[%s] %s", self.job["id"][:8], msg)

    def error(self, msg):
        log.error("[%s] %s", self.job["id"][:8], msg)


def output_stem(job) -> Path:
    out_dir = Path(job["dir"] or settings["fallback_dir"])
    return out_dir / job["stem"]


def run_download(job, url, method):
    cid = job["id"]
    stem = output_stem(job)
    stem.parent.mkdir(parents=True, exist_ok=True)

    def hook(d):
        if cancel_flags.get(cid):
            raise DownloadCancelled("cancelled by user")
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            fi, fc = d.get("fragment_index"), d.get("fragment_count")
            with lock:
                job["downloaded"] = done
                job["total"] = total
                job["speed"] = d.get("speed")
                job["eta"] = d.get("eta")
                job["phase"] = "downloading"
                if fi and fc:
                    job["progress"] = min(fi / fc, 1.0)
                elif total:
                    job["progress"] = min(done / total, 1.0)
        elif d.get("status") == "finished":
            with lock:
                job["phase"] = "processing"
                job["filename"] = d.get("filename") or job.get("filename")

    def pp_hook(d):
        if d.get("status") == "started":
            with lock:
                job["phase"] = "processing"

    headers = {k: v for k, v in (job.get("headers") or {}).items() if v}
    opts = {
        "outtmpl": str(stem) + ".%(ext)s",
        "http_headers": headers,
        "merge_output_format": "mp4",
        "format": "bv*+ba/b",
        "noplaylist": True,
        "concurrent_fragment_downloads": int(settings.get("fragment_threads", 4)),
        "retries": 10,
        "fragment_retries": 10,
        "file_access_retries": 5,
        "continuedl": True,
        "overwrites": False,
        "windowsfilenames": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "logger": JobLogger(job),
        "progress_hooks": [hook],
        "postprocessor_hooks": [pp_hook],
        "socket_timeout": 30,
    }
    if FFMPEG:
        opts["ffmpeg_location"] = FFMPEG
    cookiefile = write_cookiefile(job)
    if cookiefile:
        opts["cookiefile"] = cookiefile

    with lock:
        job["method"] = method
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        if info and info.get("_type") == "playlist":
            entries = [e for e in (info.get("entries") or []) if e]
            info = entries[0] if entries else info
        fp = None
        for rd in (info or {}).get("requested_downloads") or []:
            fp = rd.get("filepath") or fp
        if not fp and info:
            fp = ydl.prepare_filename(info)
        return fp


def remove_partials(job):
    """Delete .part/.ytdl leftovers of a cancelled job. Fragment threads may still
    hold handles for a few seconds on Windows, so retry in the background."""
    stem = output_stem(job)

    def sweep():
        for _ in range(30):
            # yt-dlp leaves the .part handle open when a hook cancels; the file
            # object is only reachable from the dead exception/frames -> collect it.
            gc.collect()
            left = 0
            try:
                for f in stem.parent.glob(glob_escape(stem.name) + ".*"):
                    n = f.name.lower()
                    if ".part" in n or n.endswith(".ytdl") or ".temp." in n:
                        try:
                            f.unlink(missing_ok=True)
                        except OSError:
                            left += 1
            except Exception:
                log.exception("remove partials")
                return
            if not left:
                return
            time.sleep(1)
        log.warning("could not remove all partial files for %s", stem)

    threading.Thread(target=sweep, daemon=True).start()


def glob_escape(s):
    return re.sub(r"([\[\]*?])", r"[\1]", s)


def worker(job):
    cid = job["id"]
    log.info("start %s %s", cid[:8], job.get("title"))
    try:
        result = None
        errors = []
        attempts_list = []
        extractor = specific_extractor(job.get("page_url"))
        if extractor and job.get("page_url"):
            attempts_list.append((job["page_url"], f"yt-dlp:{extractor}"))
        if job.get("media_url"):
            attempts_list.append((job["media_url"], f"stream:{job.get('kind') or 'auto'}"))
        if not attempts_list and job.get("page_url"):
            attempts_list.append((job["page_url"], "yt-dlp:generic"))
        for url, method in attempts_list:
            try:
                result = run_download(job, url, method)
                break
            except DownloadCancelled:
                raise
            except Exception as e:
                if cancel_flags.get(cid):
                    raise DownloadCancelled()
                msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e)).replace("ERROR: ", "")
                errors.append(f"{method}: {msg}")
                log.warning("[%s] %s failed: %s", cid[:8], method, msg)
        with lock:
            if result is not None:
                job.update(status="done", progress=1.0, finished=time.time(),
                           filename=result, error=None, speed=None, eta=None, phase=None)
                Path(DATA / "cookies" / f"{cid}.txt").unlink(missing_ok=True)
                log.info("done %s -> %s", cid[:8], result)
            else:
                job["attempts"] = job.get("attempts", 0) + 1
                job["error"] = " | ".join(errors)[-800:] or "unknown error"
                job["speed"] = job["eta"] = job["phase"] = None
                if job["attempts"] < int(settings.get("max_attempts", 3)):
                    job["status"] = "queued"
                    job["next_try"] = time.time() + 20 * job["attempts"]
                else:
                    job["status"] = "error"
                    job["finished"] = time.time()
    except DownloadCancelled:
        with lock:
            job.update(status="cancelled", finished=time.time(), speed=None, eta=None, phase=None)
        remove_partials(job)
        log.info("cancelled %s", cid[:8])
    except Exception:
        log.exception("worker crash")
        with lock:
            job.update(status="error", error=traceback.format_exc()[-800:], finished=time.time())
    finally:
        cancel_flags.pop(cid, None)
        save_jobs()
        wake.set()


def scheduler():
    last_save = 0
    while True:
        wake.wait(1.0)
        wake.clear()
        now = time.time()
        with lock:
            running = [j for j in jobs if j["status"] == "running"]
            per_site = {}
            for j in running:
                per_site[j["site"]] = per_site.get(j["site"], 0) + 1
            # browser jobs whose Firefox worker went away -> back to the queue
            for j in running[:]:
                if j.get("engine") == "browser" and not j.get("b_finished") \
                        and (j.get("lease") or 0) < now:
                    j.update(status="queued", phase="waiting for Firefox",
                             delivered_at=None, speed=None, eta=None)
                    running.remove(j)
                    per_site[j["site"]] -= 1
            connected = browser_connected()
            glimit = int(settings.get("global_limit", 9))
            for j in sorted((j for j in jobs if j["status"] == "queued"),
                            key=lambda j: j.get("created", 0)):
                if len(running) >= glimit:
                    break
                if (j.get("next_try") or 0) > now:
                    continue
                if j.get("engine") == "browser" and not connected:
                    j["phase"] = "waiting for Firefox"
                    continue
                limit = int(settings.get("site_limits", {}).get(
                    j["site"], settings.get("per_site_limit", 3)))
                if per_site.get(j["site"], 0) >= limit:
                    continue
                j.update(status="running", started=now, phase="starting", next_try=None)
                per_site[j["site"]] = per_site.get(j["site"], 0) + 1
                running.append(j)
                if j.get("engine") == "browser":
                    # handed to Firefox on its next poll
                    j.update(delivered_at=None, lease=now + BROWSER_LEASE, b_finished=False,
                             method="firefox:" + (j.get("kind") or "?"))
                else:
                    threading.Thread(target=worker, args=(j,), daemon=True).start()
            if running and now - last_save > 10:
                last_save = now
                save_json(JOBS_FILE, jobs)


def unique_stem(dir_, stem):
    """Avoid two jobs (or an existing finished file) writing to the same name."""
    taken = {(j.get("dir"), j.get("stem")) for j in jobs
             if j["status"] in ("queued", "running")}
    base, n = stem, 1
    while True:
        exists = Path(dir_, stem + ".mp4").exists() or Path(dir_, stem + ".mkv").exists()
        if (dir_, stem) not in taken and not exists:
            return stem
        n += 1
        stem = f"{base} ({n})"


def add_job(spec):
    page = spec.get("page_url") or ""
    media = spec.get("media_url") or ""
    if not page and not media:
        raise ValueError("job needs page_url or media_url")
    with lock:
        # skip exact duplicates still in the queue
        for j in jobs:
            if j["status"] in ("queued", "running") and j.get("media_url") == media \
                    and j.get("page_url") == page:
                return j
        dir_ = spec.get("dir") or settings["fallback_dir"]
        job = {
            "id": uuid.uuid4().hex,
            "status": "queued",
            "site": site_key(spec.get("site") or page or media),
            "page_url": page,
            "media_url": media,
            "kind": spec.get("kind"),
            "title": spec.get("title") or "",
            "dir": dir_,
            "headers": spec.get("headers") or {},
            "cookies": spec.get("cookies") or [],
            "height": spec.get("height"),
            "created": time.time(),
            "attempts": 0,
            "progress": 0.0,
        }
        job["engine"] = spec.get("engine") or default_engine(job)
        if job["engine"] == "browser" and job["kind"] not in ("hls", "direct"):
            job["engine"] = "ytdlp"
        job["stem"] = unique_stem(dir_, safe_name(job["title"]))
        jobs.append(job)
        log.info("queued %s %s [%s]", job["id"][:8], job["title"], job["site"])
    save_jobs()
    wake.set()
    return job


_picker_lock = threading.Lock()


def pick_folder(initial):
    """Native folder dialog. Tk lives entirely on its own thread (works in the
    packaged exe too, where `python -c` is not available)."""
    result = {}

    def run():
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        try:
            root.withdraw()
            root.attributes("-topmost", True)
            root.update()
            result["path"] = filedialog.askdirectory(
                parent=root, initialdir=initial or None,
                title="VidQueue - choose download folder", mustexist=False)
        finally:
            root.destroy()

    with _picker_lock:  # one dialog at a time
        t = threading.Thread(target=run, daemon=True)
        t.start()
        t.join(900)
    p = result.get("path")
    return str(Path(p)) if p else None


# ---------------------------------------------------------- browser engine
def parts_dir(job) -> Path:
    return Path(job["dir"] or settings["fallback_dir"]) / ".vidqueue-parts" / job["id"]


def remove_parts(job, delay=3.0):
    pd = parts_dir(job)

    def go():
        time.sleep(delay)
        for _ in range(10):
            shutil.rmtree(pd, ignore_errors=True)
            if not pd.exists():
                break
            time.sleep(1)
        try:
            pd.parent.rmdir()  # only succeeds when empty
        except OSError:
            pass

    threading.Thread(target=go, daemon=True).start()


def browser_job_payload(j):
    keys = ("id", "media_url", "page_url", "kind", "headers", "cookies", "title", "height")
    p = {k: j.get(k) for k in keys}
    p["threads"] = int(settings.get("fragment_threads", 4))
    return p


def browser_poll(body):
    now = time.time()
    browser_state["last_poll"] = now
    active = set(body.get("active") or [])
    assign, cancel = [], []
    with lock:
        byid = {j["id"]: j for j in jobs}
        for jid in active:
            j = byid.get(jid)
            if not j or j["status"] != "running" or j.get("engine") != "browser" or j.get("b_finished"):
                cancel.append(jid)
            else:
                j["lease"] = now + BROWSER_LEASE
        for j in jobs:
            if j.get("engine") != "browser" or j["status"] != "running" or j.get("b_finished"):
                continue
            if j["id"] in active:
                continue
            if not j.get("delivered_at") or now - j["delivered_at"] > 8:
                j.update(delivered_at=now, lease=now + BROWSER_LEASE, phase="starting")
                assign.append(browser_job_payload(j))
    wake.set()
    return {"assign": assign, "cancel": cancel}


def running_browser_job(jid):
    j = next((j for j in jobs if j["id"] == jid), None)
    if not j or j["status"] != "running" or j.get("engine") != "browser":
        return None
    return j


def note_bytes(job, n, add=True):
    """Track throughput for the dashboard (5 s sliding window)."""
    now = time.time()
    win = job.setdefault("_win", [])
    win.append((now, n))
    while win and now - win[0][0] > 5:
        win.pop(0)
    span = max(now - win[0][0], 1.0)
    job["speed"] = sum(b for _, b in win) / span
    if add:
        job["downloaded"] = (job.get("downloaded") or 0) + n


def browser_plan(job, body):
    pd = parts_dir(job)
    pd.mkdir(parents=True, exist_ok=True)
    mode = body.get("mode")
    if body.get("height"):
        job["height"] = body["height"]
    if mode == "hls":
        names = [r["name"] for r in body.get("resources", [])]
        tracks = [t["name"] for t in body.get("tracks", [])]
        if not names or not all(_res_name.match(n) for n in names) \
                or not tracks or any(t not in ("video", "audio") for t in tracks):
            raise ValueError("bad plan")
        for t in body["tracks"]:
            (pd / f"{t['name']}.m3u8").write_text(t["playlist"], encoding="utf-8")
        have = [n for n in names if (pd / n).exists()]
        job.update(b_mode="hls", b_tracks=tracks, b_total=len(names), b_done=len(have),
                   b_t0=time.time(), b_n0=len(have), downloaded=0, _win=[],
                   progress=len(have) / len(names), phase="downloading", error=None)
        return {"have": have}
    if mode == "direct":
        f = pd / "file.part"
        have = f.stat().st_size if f.exists() else 0
        job.update(b_mode="direct", downloaded=have, _win=[], phase="downloading", error=None)
        return {"have_bytes": have}
    raise ValueError("unknown mode")


def browser_resource(job, name, data):
    if job.get("b_mode") != "hls" or not _res_name.match(name):
        raise ValueError("bad resource")
    pd = parts_dir(job)
    target = pd / name
    existed = target.exists()
    tmp = pd / (name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, target)
    with lock:
        if not existed:
            job["b_done"] = job.get("b_done", 0) + 1
        note_bytes(job, len(data))
        total = max(job.get("b_total") or 1, 1)
        job["progress"] = min(job["b_done"] / total, 1.0)
        got = job["b_done"] - job.get("b_n0", 0)
        if got > 0:
            per = (time.time() - job["b_t0"]) / got
            job["eta"] = per * (total - job["b_done"])
            if job["b_done"] > 0:  # estimate final size from average segment size
                job["total"] = job["downloaded"] / got * total if got else None


def browser_chunk(job, offset, total, data):
    if job.get("b_mode") != "direct":
        raise ValueError("bad mode")
    f = parts_dir(job) / "file.part"
    size = f.stat().st_size if f.exists() else 0
    if offset == 0 and size:
        f.unlink()
        size = 0
    if offset != size:
        return {"ok": False, "have_bytes": size}
    with open(f, "ab") as fh:
        fh.write(data)
    with lock:
        note_bytes(job, len(data), add=False)
        job["downloaded"] = offset + len(data)
        if total:
            job["total"] = total
            job["progress"] = min(job["downloaded"] / total, 1.0)
            if job.get("speed"):
                job["eta"] = (total - job["downloaded"]) / job["speed"]
    return {"ok": True, "have_bytes": offset + len(data)}


def browser_fail(job, error):
    with lock:
        job["attempts"] = job.get("attempts", 0) + 1
        job["error"] = f"{job.get('method')}: {error}"[-800:]
        job.update(speed=None, eta=None, phase=None, delivered_at=None)
        if job["attempts"] < int(settings.get("max_attempts", 3)):
            job["status"] = "queued"
            job["next_try"] = time.time() + 20 * job["attempts"]
        else:
            job["status"] = "error"
            job["finished"] = time.time()
    save_jobs()
    wake.set()


def browser_finish(job):
    with lock:
        job.update(b_finished=True, phase="processing", speed=None, eta=None)
    threading.Thread(target=merge_job, args=(job,), daemon=True).start()


def merge_job(job):
    pd = parts_dir(job)
    stem = output_stem(job)
    stem.parent.mkdir(parents=True, exist_ok=True)
    try:
        if job.get("b_mode") == "direct":
            ext = Path(job.get("media_url", "").split("?")[0]).suffix.lower()
            if ext not in (".mp4", ".webm", ".mkv", ".flv", ".mov", ".m4v", ".avi", ".wmv"):
                ext = ".mp4"
            final = Path(str(stem) + ext)
            shutil.move(str(pd / "file.part"), str(final))
        else:
            if not FFMPEG:
                raise RuntimeError("ffmpeg not found")
            exe = str(Path(FFMPEG) / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"))
            final = Path(str(stem) + ".mp4")
            tmp = Path(str(stem) + ".merging.mp4")
            cmd = [exe, "-y", "-hide_banner", "-loglevel", "error"]
            for t in job["b_tracks"]:
                cmd += ["-allowed_extensions", "ALL", "-extension_picky", "0",
                        "-protocol_whitelist", "file,crypto,data", "-i", f"{t}.m3u8"]
            if len(job["b_tracks"]) == 2:
                cmd += ["-map", "0:v?", "-map", "1:a?"]
            else:
                cmd += ["-map", "0:v?", "-map", "0:a?"]
            cmd += ["-c", "copy", "-movflags", "+faststart", str(tmp)]
            r = subprocess.run(cmd, cwd=str(pd), capture_output=True, text=True,
                               creationflags=NO_WINDOW)
            if r.returncode != 0 or not tmp.exists():
                tmp.unlink(missing_ok=True)
                raise RuntimeError("ffmpeg merge failed: " + (r.stderr or "")[-500:])
            os.replace(tmp, final)
        with lock:
            job.update(status="done", progress=1.0, finished=time.time(), filename=str(final),
                       error=None, phase=None)
        log.info("done %s -> %s", job["id"][:8], final)
        remove_parts(job, delay=0)
    except Exception as e:
        log.exception("merge %s", job["id"][:8])
        with lock:
            job.update(status="error", error=str(e)[-800:], finished=time.time(), phase=None)
    finally:
        save_jobs()
        wake.set()


# ------------------------------------------------------------------ server
ALLOWED_ORIGIN_PREFIXES = ("moz-extension://", f"http://{HOST}:{PORT}", f"http://localhost:{PORT}")


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "VidQueue/" + VERSION

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _allowed(self):
        origin = self.headers.get("Origin")
        if origin and not origin.startswith(ALLOWED_ORIGIN_PREFIXES):
            return False
        return self.headers.get("X-VidQueue") == "1"

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            return self._send(200, (APP_DIR / "dashboard.html").read_bytes(), "text/html; charset=utf-8")
        if path in ("/icon.png", "/favicon.ico"):
            try:
                return self._send(200, resource("assets/vidqueue.png").read_bytes(), "image/png")
            except Exception:
                return self._send(404, {"error": "no icon"})
        if path == "/api/ping":
            return self._send(200, {"ok": True, "version": VERSION, "ffmpeg": bool(FFMPEG)})
        if path == "/api/about":
            if not self._allowed():
                return self._send(403, {"error": "forbidden"})
            return self._send(200, about_info())
        if path == "/api/status":
            if not self._allowed():
                return self._send(403, {"error": "forbidden"})
            with lock:
                return self._send(200, {
                    "version": VERSION,
                    "ffmpeg": bool(FFMPEG),
                    "browser": browser_connected(),
                    "update": update_public(),
                    "can_update": FROZEN or UPDATE_TEST,
                    "settings": settings,
                    "jobs": [public(j) for j in jobs],
                })
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._allowed():
            return self._send(403, {"error": "forbidden"})
        path, _, query = self.path.partition("?")
        # binary uploads from the Firefox worker
        m = re.fullmatch(r"/api/browser/([0-9a-f]+)/(res|chunk)(?:/([A-Za-z0-9_.-]+))?", path)
        if m:
            n = int(self.headers.get("Content-Length") or 0)
            data = self.rfile.read(n) if n else b""
            with lock:
                job = running_browser_job(m.group(1))
            if not job:
                return self._send(409, {"error": "job not running", "cancel": True})
            try:
                if m.group(2) == "res":
                    browser_resource(job, m.group(3) or "", data)
                    return self._send(200, {"ok": True})
                q = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
                return self._send(200, browser_chunk(job, int(q.get("offset", 0)),
                                                     int(q.get("total", 0) or 0), data))
            except Exception as e:
                log.exception("upload")
                return self._send(500, {"error": str(e)})
        try:
            body = self._body()
        except Exception:
            return self._send(400, {"error": "bad json"})
        try:
            if path == "/api/browser/poll":
                return self._send(200, browser_poll(body))
            m = re.fullmatch(r"/api/browser/([0-9a-f]+)/(plan|finish|fail)", path)
            if m:
                with lock:
                    job = running_browser_job(m.group(1))
                if not job:
                    return self._send(409, {"error": "job not running", "cancel": True})
                if m.group(2) == "plan":
                    return self._send(200, browser_plan(job, body))
                if m.group(2) == "finish":
                    browser_finish(job)
                else:
                    browser_fail(job, str(body.get("error") or "unknown error"))
                return self._send(200, {"ok": True})
            if path == "/api/jobs":
                specs = body.get("jobs") or [body]
                added = [public(add_job(s)) for s in specs]
                return self._send(200, {"added": added})
            if path == "/api/settings":
                with lock:
                    for k in DEFAULT_SETTINGS:
                        if k in body and k != "tray":
                            settings[k] = body[k]
                if "tray" in body:
                    set_tray(bool(body["tray"]))  # applies the Start-with-Windows lock
                with lock:
                    settings["site_limits"] = {
                        site_key(k): int(v) for k, v in (settings.get("site_limits") or {}).items()
                    }
                save_settings()
                wake.set()
                return self._send(200, {"settings": settings})
            if path == "/api/ext-settings":
                # {"settings": {...}} stores the add-on's options; {} reads them back
                new = body.get("settings")
                if isinstance(new, dict):
                    if len(json.dumps(new)) > 65536:
                        return self._send(400, {"error": "too large"})
                    with lock:
                        save_json(EXT_SETTINGS_FILE, new)
                    return self._send(200, {"ok": True})
                return self._send(200, {"settings": load_json(EXT_SETTINGS_FILE, {})})
            if path == "/api/autostart":
                set_autostart(bool(body.get("on")))
                return self._send(200, {"autostart": autostart_enabled(), "tray": tray_wanted()})
            if path == "/api/tray":
                set_tray(bool(body.get("on")))
                return self._send(200, {"autostart": autostart_enabled(), "tray": tray_wanted()})
            if path == "/api/update/check":
                err = check_update()
                return self._send(200, {"current": VERSION, "error": err, "update": update_public(),
                                        "can_install": FROZEN or UPDATE_TEST})
            if path == "/api/update/install":
                err = start_update()
                return self._send(400 if err else 200, {"error": err} if err else {"ok": True, "update": update_public()})
            if path == "/api/quit":
                threading.Timer(0.5, quit_event.set).start()
                return self._send(200, {"ok": True})
            if path == "/api/pick-folder":
                return self._send(200, {"path": pick_folder(body.get("initial"))})
            if path == "/api/clear":
                with lock:
                    for j in jobs:
                        if j["status"] in ("error", "cancelled") and j.get("engine") == "browser":
                            remove_parts(j)
                    jobs[:] = [j for j in jobs if j["status"] in ("queued", "running")]
                save_jobs()
                return self._send(200, {"ok": True})
            m = re.fullmatch(r"/api/jobs/([0-9a-f]+)/(cancel|retry|remove|open|top)", path)
            if m:
                return self._job_action(m.group(1), m.group(2))
        except Exception as e:
            log.exception("POST %s", path)
            return self._send(500, {"error": str(e)})
        self._send(404, {"error": "not found"})

    def _job_action(self, jid, action):
        with lock:
            job = next((j for j in jobs if j["id"] == jid), None)
            if not job:
                return self._send(404, {"error": "no such job"})
            browser = job.get("engine") == "browser"
            if action == "cancel":
                if job["status"] == "running" and not browser:
                    cancel_flags[jid] = True
                elif job["status"] in ("queued", "running"):
                    # browser jobs: Firefox learns about it on its next poll
                    job.update(status="cancelled", finished=time.time(), speed=None, eta=None, phase=None)
                    if browser:
                        remove_parts(job)
            elif action == "retry":
                if job["status"] in ("error", "cancelled"):
                    job.update(status="queued", attempts=0, error=None, next_try=None,
                               progress=0.0, finished=None, created=time.time(),
                               b_finished=False, delivered_at=None)
                    if job.get("kind") in ("hls", "direct") and job.get("media_url"):
                        job["engine"] = default_engine(job)
            elif action == "top":
                if job["status"] == "queued":
                    job["created"] = min(j.get("created", 0) for j in jobs) - 1
                    job["next_try"] = None
            elif action == "remove":
                if job["status"] == "running" and not browser:
                    cancel_flags[jid] = True
                if browser and job["status"] != "done":
                    remove_parts(job)
                jobs.remove(job)
            elif action == "open":
                target = job.get("filename")
                if target and Path(target).exists():
                    subprocess.Popen(["explorer", "/select,", str(Path(target))])
                else:
                    d = Path(job["dir"] or settings["fallback_dir"])
                    d.mkdir(parents=True, exist_ok=True)
                    subprocess.Popen(["explorer", str(d)])
        save_jobs()
        wake.set()
        return self._send(200, {"ok": True})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = False


# ------------------------------------------------- about / updates / login
def resource(name) -> Path:
    """Bundled file: inside the exe bundle when frozen, repo root otherwise."""
    for base in (APP_DIR, BASE, INSTALL_DIR):
        p = base / name
        if p.exists():
            return p
    return BASE / name


_ffmpeg_version = None


def ffmpeg_version():
    global _ffmpeg_version
    if _ffmpeg_version is None:
        _ffmpeg_version = "not found"
        if FFMPEG:
            try:
                exe = str(Path(FFMPEG) / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"))
                out = subprocess.run([exe, "-version"], capture_output=True, text=True,
                                     timeout=15, creationflags=NO_WINDOW).stdout
                m = re.search(r"ffmpeg version (\S+)", out)
                _ffmpeg_version = m.group(1) if m else "unknown"
            except Exception:
                _ffmpeg_version = "error"
    return _ffmpeg_version


def pkg_version(name):
    try:
        from importlib.metadata import version
        return version(name)
    except Exception:
        return "bundled"


def software_used():
    try:
        import tkinter
        tkv = str(tkinter.TkVersion)
    except Exception:
        tkv = "n/a"
    items = [
        ("Python", platform.python_version(), "PSF License"),
        ("yt-dlp", yt_dlp.version.__version__, "Unlicense"),
        ("FFmpeg", ffmpeg_version(), "GPLv3 (gyan.dev build; source at ffmpeg.org)"),
        ("Tcl/Tk", tkv, "Tcl/Tk License"),
        ("pystray", pkg_version("pystray"), "LGPLv3"),
        ("Pillow", pkg_version("Pillow"), "HPND"),
    ]
    if FROZEN:
        items.append(("PyInstaller", "self-contained Windows packaging", "GPLv2 with bootloader exception"))
    return [{"name": n, "version": v, "license": lic} for n, v, lic in items]


def about_info():
    try:
        eula = resource("EULA.txt").read_text(encoding="utf-8")
    except Exception as e:
        eula = f"EULA.txt not found ({e})"
    return {
        "name": "VidQueue", "version": VERSION, "bits": "64-bit" if sys.maxsize > 2**32 else "32-bit",
        "publisher": PUBLISHER, "copyright": f"Copyright © 2026 {PUBLISHER}",
        "description": "Queue videos from Firefox and download them with a per-site concurrency limit.",
        "app_dir": str(INSTALL_DIR), "data_dir": str(DATA),
        "python": platform.python_version(), "windows": platform.platform(),
        "packaged": FROZEN, "repo": f"https://github.com/{GITHUB_REPO}",
        "autostart": autostart_enabled(), "tray": tray_wanted(), "launch": LAUNCH,
        "native_host": NATIVE_HOST, "update": update_public(), "can_update": FROZEN or UPDATE_TEST,
        "software": software_used(), "eula": eula,
    }


# --- updates (GitHub releases) -----------------------------------------
# The check runs at start, every 6 hours and on demand (About > Check for
# updates). "Update now" downloads the release zip, verifies its SHA-256 (the
# asset digest GitHub publishes, else the hash in the release notes), extracts
# it and hands over to its installer in update mode, which closes VidQueue,
# installs the new files with the same choices and starts VidQueue again.
UPDATE_API = os.environ.get("VIDQUEUE_UPDATE_API") or f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
UPDATE_TEST = bool(os.environ.get("VIDQUEUE_UPDATE_API"))  # test server: any asset host, also from source
UPDATE_DRYRUN = bool(os.environ.get("VIDQUEUE_UPDATE_DRYRUN"))  # tests: stop before launching the installer
update_info = {"latest": None, "url": None, "asset": None, "size": 0, "sha256": None, "checked": None}
update_state = {"phase": None, "progress": 0.0, "error": None}  # downloading / verifying / installing / error
update_lock = threading.Lock()


def ver_tuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or "")[:3]) or (0,)


def update_public():
    return dict(update_info, state=dict(update_state)) if update_info["latest"] else None


def check_update():
    """Ask GitHub for the latest release. Returns an error string, or None."""
    import urllib.request
    try:
        req = urllib.request.Request(UPDATE_API, headers={
            "User-Agent": f"VidQueue/{VERSION}", "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        update_info["checked"] = time.time()
        return f"couldn't reach GitHub ({e})"
    update_info["checked"] = time.time()
    tag = (d.get("tag_name") or "").lstrip("vV")
    if ver_tuple(tag) <= ver_tuple(VERSION):
        update_info.update(latest=None, url=None, asset=None, size=0, sha256=None)
        return None
    name = f"VidQueue-{tag}-windows.zip"
    asset = next((a for a in d.get("assets") or [] if a.get("name") == name), None)
    sha = None
    if asset and str(asset.get("digest") or "").startswith("sha256:"):
        sha = asset["digest"].split(":", 1)[1].lower()
    if not sha:  # release notes: SHA-256 (zip): `<hash>`
        m = re.search(r"SHA-?256[^`\n]*`([0-9a-fA-F]{64})`", d.get("body") or "")
        sha = m.group(1).lower() if m else None
    update_info.update(latest=tag, url=d.get("html_url"), asset=asset and asset.get("browser_download_url"),
                       size=(asset or {}).get("size") or 0, sha256=sha)
    return None


def update_loop():
    while True:
        if settings.get("check_updates", True):
            check_update()
        time.sleep(6 * 3600)


def start_update():
    """Begin a one-click update in the background. Returns an error string, or None."""
    if not FROZEN and not UPDATE_TEST:
        return "VidQueue is running from source: update it with git instead."
    if not update_info["latest"]:
        return "VidQueue is up to date."
    if not update_info["asset"]:
        return f"Release {update_info['latest']} has no Windows package to install."
    if not update_info["sha256"]:
        return f"Release {update_info['latest']} has no SHA-256 to verify the download against."
    if not UPDATE_TEST and not update_info["asset"].startswith(f"https://github.com/{GITHUB_REPO}/releases/download/"):
        return "The update package isn't on VidQueue's GitHub releases page."
    with update_lock:
        phase = update_state["phase"]
        # "installing" means the installer should close VidQueue any moment; if it
        # hasn't after 2 minutes (it failed before getting that far), allow a retry
        stuck = phase == "installing" and (UPDATE_DRYRUN or time.time() - update_state.get("at", 0) > 120)
        if phase in ("downloading", "verifying", "installing") and not stuck:
            return None  # already on its way
        update_state.update(phase="downloading", progress=0.0, error=None)
    threading.Thread(target=run_update, args=(dict(update_info),), daemon=True).start()
    return None


def run_update(info):
    import hashlib
    import urllib.request
    import zipfile
    work = DATA / "update"
    try:
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True, exist_ok=True)
        zpath = work / f"VidQueue-{info['latest']}-windows.zip"
        h = hashlib.sha256()
        req = urllib.request.Request(info["asset"], headers={"User-Agent": f"VidQueue/{VERSION}"})
        with urllib.request.urlopen(req, timeout=60) as r, open(zpath, "wb") as f:
            total = int(r.headers.get("Content-Length") or info.get("size") or 0)
            done = 0
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                h.update(chunk)
                done += len(chunk)
                if total:
                    update_state["progress"] = min(done / total, 1.0)
        update_state.update(phase="verifying", progress=1.0)
        if h.hexdigest() != info["sha256"]:
            raise RuntimeError("the download doesn't match the published SHA-256, so it wasn't installed")
        pkg = work / f"VidQueue-{info['latest']}-windows"
        with zipfile.ZipFile(zpath) as z:
            z.extractall(pkg)  # zipfile drops absolute and ".." parts of entry names
        installer = pkg / "setup" / "install_windows.ps1"
        if not installer.is_file() or not (pkg / "app" / "VidQueue.exe").is_file():
            raise RuntimeError("the update package is incomplete")
        zpath.unlink(missing_ok=True)
        update_state.update(phase="installing", at=time.time())
        log.info("update %s -> %s: starting the installer", VERSION, info["latest"])
        if UPDATE_DRYRUN:
            return
        # the installer closes this process, so it must not belong to this process's job
        cmd = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
               "-File", str(installer), "-Update"]
        # CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP. Not DETACHED_PROCESS: Windows
        # PowerShell 5.1 without a console exits at once (code 0) and does nothing.
        flags = 0x08000000 | 0x00000200
        # the installer starts the new VidQueue: don't hand it test overrides (data folder, port)
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith("VIDQUEUE_")}
        try:
            subprocess.Popen(cmd, cwd=str(pkg), env=env, creationflags=flags | 0x01000000)  # + CREATE_BREAKAWAY_FROM_JOB
        except OSError:
            subprocess.Popen(cmd, cwd=str(pkg), env=env, creationflags=flags)
    except Exception as e:
        log.warning("update failed: %s", e)
        update_state.update(phase="error", error=str(e))


# --- launch modes & lifetime -------------------------------------------
# How VidQueue was started decides when it quits:
#   --autostart     (Windows login)    stays running until Quit
#   --from-firefox  (native messaging) quits once Firefox is gone and work is done
#   manual          stays running if the tray icon is shown, otherwise like Firefox
EXT_ID = "vidqueue@local.ext"
NATIVE_HOST = "com.cannontech.vidqueue"
LAUNCH = "autostart" if "--autostart" in sys.argv else "firefox" if "--from-firefox" in sys.argv else "manual"
IDLE_QUIT_AFTER = int(os.environ.get("VIDQUEUE_IDLE_QUIT", "120"))  # seconds without Firefox
quit_event = threading.Event()
start_time = time.time()

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def autostart_command():
    if FROZEN:
        return f'"{sys.executable}" --autostart'
    pyw = Path(sys.executable).with_name("pythonw.exe")
    return f'"{pyw if pyw.exists() else sys.executable}" "{Path(__file__).resolve()}" --autostart'


def autostart_enabled():
    if os.name != "nt":
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            winreg.QueryValueEx(k, "VidQueue")
            return True
    except OSError:
        return False


def set_autostart(on):
    """Start with Windows. Turning it on also turns the tray icon on (and locks
    it on): an always-running app must be visible and quittable."""
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        if on:
            winreg.SetValueEx(k, "VidQueue", 0, winreg.REG_SZ, autostart_command())
        else:
            try:
                winreg.DeleteValue(k, "VidQueue")
            except OSError:
                pass
    if on:
        set_tray(True)


def tray_wanted():
    return bool(settings.get("tray")) or autostart_enabled()


def set_tray(on):
    if not on and autostart_enabled():
        on = True  # locked on while Start with Windows is on
    with lock:
        settings["tray"] = bool(on)
    save_settings()
    tray.apply()


def persistent():
    """True when VidQueue should keep running without Firefox."""
    if LAUNCH == "autostart":
        return True
    if LAUNCH == "manual" and tray_wanted():
        return True
    return False


def busy_without_firefox():
    """Work that can still finish after Firefox is gone."""
    with lock:
        for j in jobs:
            if j["status"] == "running" and (j.get("engine") != "browser" or j.get("b_finished")):
                return True
            if j["status"] == "queued" and j.get("engine") != "browser":
                return True
    return False


def should_idle_quit(now=None):
    """Quit when not persistent, no Firefox has checked in for IDLE_QUIT_AFTER
    seconds, and nothing that can finish without Firefox is left."""
    if persistent():
        return False
    now = now or time.time()
    last = max(browser_state["last_poll"], start_time)
    return now - last >= IDLE_QUIT_AFTER and not busy_without_firefox()


def idle_watch():
    while not quit_event.wait(5):
        if should_idle_quit():
            log.info("no Firefox and nothing left to finish: quitting")
            quit_event.set()


# --- tray icon (can be shown/hidden while running) ----------------------
def icon_image():
    from PIL import Image, ImageDraw
    p = resource("assets/vidqueue.png")
    if p.exists():
        return Image.open(p).convert("RGBA")
    im = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((4, 10, 60, 54), 9, fill=(47, 111, 237, 255))
    d.polygon([(25, 21), (25, 37), (38, 29)], fill="white")
    return im


def tray_title():
    with lock:
        run = sum(1 for j in jobs if j["status"] == "running")
        q = sum(1 for j in jobs if j["status"] == "queued")
    t = f"VidQueue {VERSION}"
    if run or q:
        t += f" - {run} downloading, {q} queued"
    return t[:127]


class Tray:
    def __init__(self):
        self.icon = None
        self._lock = threading.Lock()

    def apply(self):
        want = tray_wanted() and not quit_event.is_set() and "--no-tray" not in sys.argv
        with self._lock:
            if want and not self.icon:
                self._start()
            elif not want and self.icon:
                self._stop()

    def _start(self):
        try:
            import pystray
            from pystray import Menu, MenuItem as Item
        except Exception:
            log.warning("pystray not available: no tray icon")
            return
        import webbrowser
        url = f"http://{HOST}:{PORT}/"
        self.icon = pystray.Icon("VidQueue", icon_image(), tray_title(), Menu(
            Item("Open dashboard", lambda *_: webbrowser.open(url), default=True),
            Item("Start with Windows", lambda *_: set_autostart(not autostart_enabled()),
                 checked=lambda _i: autostart_enabled()),
            Menu.SEPARATOR,
            Item("About VidQueue", lambda *_: webbrowser.open(url + "#about")),
            Item("Quit VidQueue", lambda *_: quit_event.set()),
        ))
        threading.Thread(target=self.icon.run, daemon=True).start()

    def _stop(self):
        try:
            self.icon.stop()
        except Exception:
            pass
        self.icon = None

    def refresh_loop(self):
        while not quit_event.wait(3):
            ic = self.icon
            if ic:
                try:
                    ic.title = tray_title()
                except Exception:
                    pass

    def shutdown(self):
        with self._lock:
            if self.icon:
                self._stop()


tray = Tray()


# --- native messaging (how Firefox starts VidQueue, like VDH's companion app)
def native_launch():
    """Firefox runs the host with (manifest path, extension id) as arguments."""
    return EXT_ID in sys.argv[1:]


def _std_binary():
    try:
        return sys.stdin.buffer, sys.stdout.buffer
    except AttributeError:  # windowed exe: build streams from the raw handles
        import ctypes
        import msvcrt
        k = ctypes.windll.kernel32
        k.GetStdHandle.restype = ctypes.c_void_p
        fin = os.fdopen(msvcrt.open_osfhandle(k.GetStdHandle(-10), os.O_RDONLY | os.O_BINARY), "rb", 0)
        fout = os.fdopen(msvcrt.open_osfhandle(k.GetStdHandle(-11), os.O_BINARY), "wb", 0)
        return fin, fout


def _read_exact(fin, n):
    buf = b""
    while len(buf) < n:
        chunk = fin.read(n - len(buf))
        if not chunk:
            break
        buf += chunk
    return buf


def _nm_read(fin):
    import struct
    raw = _read_exact(fin, 4)
    if len(raw) < 4:
        return None
    n = struct.unpack("<I", raw)[0]
    return json.loads(_read_exact(fin, n).decode("utf-8"))


def _nm_write(fout, obj):
    import struct
    data = json.dumps(obj).encode("utf-8")
    fout.write(struct.pack("<I", len(data)) + data)
    fout.flush()


def server_up(timeout=1.0):
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://{HOST}:{PORT}/api/ping", timeout=timeout) as r:
            return json.loads(r.read()).get("ok") is True
    except Exception:
        return False


def spawn_detached(extra_args):
    """Start VidQueue so it survives Firefox exiting (outside Firefox's job object)."""
    if FROZEN:
        cmd = [sys.executable, *extra_args]
    else:
        pyw = Path(sys.executable).with_name("pythonw.exe")
        cmd = [str(pyw if pyw.exists() else sys.executable), str(Path(__file__).resolve()), *extra_args]
    DETACHED, NEW_GROUP, BREAKAWAY = 0x00000008, 0x00000200, 0x01000000
    kw = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
              close_fds=True, cwd=str(INSTALL_DIR))
    try:
        return subprocess.Popen(cmd, creationflags=DETACHED | NEW_GROUP | BREAKAWAY, **kw), True
    except OSError:  # the job forbids breakaway
        return subprocess.Popen(cmd, creationflags=DETACHED | NEW_GROUP, **kw), False


def native_host():
    fin, fout = _std_binary()
    try:
        msg = _nm_read(fin) or {}
    except Exception as e:
        msg = {"cmd": "?", "error": str(e)}
    reply = {"ok": True, "version": VERSION}
    if msg.get("cmd") in ("ensure", "start"):
        if server_up():
            reply["started"] = False
        else:
            _p, broke_away = spawn_detached(["--from-firefox"])
            reply.update(started=True, breakaway=broke_away)
            for _ in range(60):  # wait up to ~15 s for the server
                if server_up(0.25):
                    break
                time.sleep(0.25)
            reply["ok"] = server_up()
    log.info("native host: %s -> %s", msg.get("cmd"), reply)
    try:
        _nm_write(fout, reply)
    except Exception:
        pass
    return 0


def native_manifest_path():
    return (INSTALL_DIR / "vidqueue-native.json") if FROZEN else (DATA / "vidqueue-native-dev.json")


def register_native():
    """Write the native-messaging manifest and its HKCU registry key.
    The installer does this for the packaged app; `--register-native` does it
    for a source checkout (through a .bat, as Firefox needs an executable)."""
    import winreg
    mpath = native_manifest_path()
    mpath.parent.mkdir(parents=True, exist_ok=True)
    if FROZEN:
        target = sys.executable
    else:
        bat = mpath.with_name("vidqueue-native-dev.bat")
        bat.write_text(f'@echo off\r\n"{Path(sys.executable)}" "{Path(__file__).resolve()}" %*\r\n', encoding="ascii")
        target = str(bat)
    manifest = {"name": NATIVE_HOST, "description": "VidQueue app launcher", "path": str(target),
                "type": "stdio", "allowed_extensions": [EXT_ID]}
    mpath.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"Software\Mozilla\NativeMessagingHosts\{NATIVE_HOST}") as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, str(mpath))
    return str(mpath)


def unregister_native():
    import winreg
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, rf"Software\Mozilla\NativeMessagingHosts\{NATIVE_HOST}")
    except OSError:
        pass


def smoke_test(out_path):
    """Checks a (packaged) build without starting the server."""
    result = {"version": VERSION, "frozen": FROZEN, "checks": {}}
    checks = result["checks"]

    def check(name, fn):
        try:
            v = fn()
            checks[name] = {"ok": True, "detail": v}
        except Exception as e:
            checks[name] = {"ok": False, "detail": f"{type(e).__name__}: {e}"}

    check("data_dir_writable", lambda: (DATA / "smoke.tmp").write_text("ok") and str(DATA))
    check("dashboard", lambda: len(resource("dashboard.html").read_bytes()))
    check("eula", lambda: len(resource("EULA.txt").read_text(encoding="utf-8")))
    check("ffmpeg", lambda: ffmpeg_version() if ffmpeg_version() not in ("not found", "error") else 1 / 0)
    if FROZEN:  # must use the copy shipped in the package, not one on the build PC
        check("ffmpeg_bundled", lambda: FFMPEG if Path(FFMPEG).resolve().is_relative_to(INSTALL_DIR) else 1 / 0)
    check("yt_dlp", lambda: specific_extractor("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
    check("tkinter", lambda: __import__("tkinter").TkVersion)
    check("pystray", lambda: __import__("pystray").Icon.__name__)
    check("icon", lambda: icon_image().size)
    check("about", lambda: len(json.dumps(about_info())))
    (DATA / "smoke.tmp").unlink(missing_ok=True)
    result["ok"] = all(c["ok"] for c in checks.values())
    Path(out_path).write_text(json.dumps(result, indent=1), encoding="utf-8")
    return 0 if result["ok"] else 1


def open_dashboard():
    import webbrowser
    webbrowser.open(f"http://{HOST}:{PORT}/")


def main():
    global settings
    if native_launch():
        sys.exit(native_host())
    if "--smoke-test" in sys.argv:
        out = sys.argv[sys.argv.index("--smoke-test") + 1]
        settings = dict(DEFAULT_SETTINGS)
        sys.exit(smoke_test(out))
    if "--register-native" in sys.argv:
        print("registered:", register_native())
        return
    if "--unregister-native" in sys.argv:
        unregister_native()
        return
    settings = {**DEFAULT_SETTINGS, **load_json(SETTINGS_FILE, {})}
    try:
        httpd = Server((HOST, PORT), Handler)
    except OSError:
        print(f"VidQueue already running on http://{HOST}:{PORT}/")
        if LAUNCH == "manual" and FROZEN:  # opened again from the Start menu: show it
            open_dashboard()
        return
    loaded = load_json(JOBS_FILE, [])
    for j in loaded:
        j.setdefault("engine", default_engine(j))
        if j.get("status") == "running":   # interrupted -> resume
            if j.get("b_finished"):        # was merging: redo the merge
                threading.Thread(target=merge_job, args=(j,), daemon=True).start()
            else:
                j["status"] = "queued"
                j["phase"] = None
                j["delivered_at"] = None
    jobs.extend(loaded)
    shutil.rmtree(DATA / "update", ignore_errors=True)  # leftovers of a finished one-click update
    if autostart_enabled():
        settings["tray"] = True
    save_settings()
    log.info("VidQueue %s started (%s launch), ffmpeg=%s", VERSION, LAUNCH, FFMPEG)
    threading.Thread(target=scheduler, daemon=True).start()
    threading.Thread(target=specific_extractor, args=("https://example.invalid/",), daemon=True).start()
    threading.Thread(target=update_loop, daemon=True).start()
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    threading.Thread(target=idle_watch, daemon=True).start()
    threading.Thread(target=tray.refresh_loop, daemon=True).start()
    tray.apply()
    if LAUNCH == "manual" and FROZEN and "--no-open" not in sys.argv:  # --no-open: restarted by an update
        open_dashboard()
    print(f"VidQueue {VERSION} running at http://{HOST}:{PORT}/  ({LAUNCH} launch, ffmpeg: {FFMPEG or 'NOT FOUND'})")
    try:
        while not quit_event.wait(1):
            pass
    except KeyboardInterrupt:
        pass
    finally:
        quit_event.set()
        tray.shutdown()
        httpd.shutdown()
        save_jobs()
        log.info("VidQueue stopped")


if __name__ == "__main__":
    main()
