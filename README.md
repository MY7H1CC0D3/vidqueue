# VidQueue

Queue videos from Firefox and download them with **no more than N at a time per site** (default 3).

- **Firefox extension** (`extension/`) detects videos the way Video DownloadHelper does: it watches
  network traffic for HLS (`.m3u8`), DASH (`.mpd`) and direct video files. It also scans the page
  itself, including packed/obfuscated player scripts, so many videos are found **without pressing play**.
- **Local app** (`app/vidqueue.py`) holds the queue and downloads with yt-dlp + ffmpeg, enforcing
  the per-site limit, with retries, resume and a queue that survives restarts.
  Dashboard: <http://127.0.0.1:9666/>

## Setup

**Packaged (friends, or your own permanent install):** unzip `VidQueue-<v>-windows.zip` and run
**Install VidQueue.bat**. It's a per-user install to `%LOCALAPPDATA%\Programs\VidQueue` with no admin
prompt, a Start menu shortcut and an Installed apps entry. Options:
- **Start with Windows**: VidQueue keeps running. This forces the tray icon on, and it can't be unticked.
- **Show tray icon**: optional otherwise. Without it VidQueue runs hidden.
- **Install the Firefox extension**: opens the signed `.xpi` in Firefox.

**How it runs (like Video DownloadHelper's companion app):** setup registers VidQueue with Firefox
(native messaging host `com.cannontech.vidqueue`). The extension asks Firefox to start it when
Firefox starts and when you queue something. It is not restarted just because you quit it.

| Started by | Keeps running? |
|---|---|
| Windows login (Start with Windows) | Yes, until Quit (tray menu, or About > Quit) |
| Firefox | Until Firefox has been gone 2 minutes **and** no joins or yt-dlp jobs are left |
| Start menu / double-click | Like Firefox, unless the tray icon is shown |

Downloads that Firefox does (Cloudflare sites) pause when Firefox exits and resume when it's back.
Start with Windows and the tray icon can be changed later in the dashboard's **About**.

**From source (development):** `run.bat` starts the app, `stop.bat` stops it.
`.venv\Scripts\python.exe appidqueue.py --register-native` registers the source checkout as the
Firefox launcher. Load `extension\manifest.json` as a temporary add-on via `about:debugging`.

## Using it

- **Toolbar button:** the badge shows how many videos were detected on the page. Click it to see them
  (quality, length, number of qualities), then **Queue best video** or queue a specific one.
  *Show filtered* reveals ads, previews and individual quality variants that were hidden.
- **Right-click a link → "queue video from this link":** opens the page in a muted background tab,
  grabs the video, closes the tab. Works from search/actress/list pages.
- **Select part of a list page → right-click → "queue all video links in selection":** queues every
  video tile in the selection (2 background tabs at a time).
- **Send page link instead:** for sites yt-dlp supports natively, which lets yt-dlp handle everything.

### Download location

- **Default** folder: set in the popup (*Default…*) or in Settings. Remembered permanently.
- **This session:** *This session…* overrides the default until Firefox closes. Handy for one batch.
- Optional: put each site's files in its own subfolder (Settings).

The folder buttons open a Windows folder picker from the app, and it can appear behind Firefox.

### Settings (popup → Settings)

| Setting | Default | Where it lives |
|---|---|---|
| Max downloads per site | 3 | app (`data/settings.json`) |
| Max downloads total | 9 | app |
| Per-site overrides (`site = limit`) | none | app |
| Auto-retries | 3 | app |
| Fragment threads per download | 4 | app |
| Ignore streams shorter than | 60 s | extension |
| Ignore files smaller than | 5 MB | extension |
| Notifications | on | extension |

If the app isn't running when you queue something, the extension holds the job and sends it
once the app starts.

## How downloads run

**Firefox engine (default for detected HLS and direct videos).** The app decides what runs and when
(the per-site limit); **Firefox does the fetching** through its own network stack and your
logged-in, Cloudflare-verified session, the same way VDH works. The extension streams the bytes to
the app, which stores the pieces in `<folder>\.vidqueue-parts\` and merges HLS into `.mp4` with
ffmpeg (AES-128 encrypted streams, fMP4 and separate audio tracks are handled).
- **Firefox must stay open** while these download. If it closes, jobs go back to the queue as
  *waiting for Firefox* and resume from the pieces already saved when it reopens.
- It can be turned off in Settings ("Download through Firefox").

**yt-dlp engine.** Used for *Send page link instead*, DASH streams, or when the Firefox engine is
turned off. If yt-dlp has a dedicated extractor for the page it uses that; otherwise it downloads
the detected stream with the browser's cookies and headers.

Files are named from the page title with the site name stripped, e.g. `ABC-123 Title.mp4`.

## Limits

- DRM-protected streams (Widevine etc.) are detected and marked, but can't be downloaded.
- If a site changes how it hides its stream URL, page scanning may miss it. Pressing play
  still works, because the network detection catches the request like VDH does.

## Releasing / sharing with friends

`build_exe.bat` builds everything into `dist\` (same approach as JAVScout: PyInstaller with a
bootloader compiled locally, smoke test, Defender scan):

| Output | What it's for |
|---|---|
| `VidQueue-<v>-windows.zip` (+ `.sha256`) | The package to share: `VidQueue.exe` (tray app, no Python needed), bundled ffmpeg, EULA, START_HERE |
| `vidqueue-extension-<v>.zip` | Upload to addons.mozilla.org → *On your own* (unlisted) for signing |
| `updates.json` | Upload to the GitHub release so installed extensions update themselves |

Release steps:
1. Bump the version in `app/vidqueue.py`, `extension/manifest.json` and `version_info.txt`; commit.
2. `build_exe.bat`, then sign `distidqueue-extension-<v>.zip` on AMO and save the signed file as
   `distidqueue-<v>.xpi`.
3. `build_exe.bat` again so the package includes the `.xpi`.
4. On GitHub (`MY7H1CC0D3/vidqueue`), create release **`v<version>`** and upload
   `VidQueue-<v>-windows.zip`, `vidqueue-<v>.xpi` and `updates.json`.
   The extension's `update_url` points at `releases/latest/download/updates.json`, and the app shows
   an "update available" banner when the latest release tag is newer than itself.

The packaged app keeps its data in `%LOCALAPPDATA%\VidQueue`; running from source keeps it in `data\`.
Tray menu: Open dashboard, Start at login, About, Quit. About is also in the dashboard header.

## Files

```
app/vidqueue.py      queue server, downloader, tray icon, About/update/autostart
app/dashboard.html   web dashboard (with About)
assets/              app icon (tools/make_icons.py renders it)
build_release.ps1    release build (build_exe.bat runs it)
EULA.txt             license shown in About and shipped in the package
extension/           Firefox extension (MV2)
data/                jobs.json, settings.json, vidqueue.log (created at runtime)
.venv/               Python env with yt-dlp
```
