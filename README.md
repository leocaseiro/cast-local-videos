# CastLocalVideos

Play local video files in your browser and cast them to Chromecast — with subtitle auto-detection, playlist support, and watch-progress sync.

The app runs as a small tray icon on your Mac. Click the tray icon, your video library opens in Chrome, and a hidden companion server streams files to your Chromecast over your Wi-Fi.

**Why:** AirPlay-style local-video casting for Chromecast users. Like Videostream, but open and self-contained.

---

## Install

Download the latest build for your Mac from the [Releases page](https://github.com/leocaseiro/cast-local-videos/releases/latest):

| Mac type | File |
| --- | --- |
| Apple Silicon (M1/M2/M3/M4) | [CastLocalVideos-arm64.dmg](https://github.com/leocaseiro/cast-local-videos/releases/latest/download/CastLocalVideos-arm64.dmg) |
| Intel | [CastLocalVideos-x64.dmg](https://github.com/leocaseiro/cast-local-videos/releases/latest/download/CastLocalVideos-x64.dmg) |

> **Not sure which Mac you have?**  → Apple menu → About This Mac. "Apple M…" is Apple Silicon; "Intel" is Intel.

### First launch (unsigned build)

The app is ad-hoc signed but not signed with an Apple Developer ID, so macOS will refuse to open it the first time. To bypass:

1. Open the `.dmg` and drag **CastLocalVideos** to your Applications folder.
2. In Applications, **right-click** CastLocalVideos → **Open**.
3. Click **Open** in the warning dialog.

On macOS Sequoia (15+) right-click → Open is gone. Instead, double-click the app once (the launch will be blocked), then go to **System Settings → Privacy & Security**, scroll to the bottom, and click **Open Anyway**.

After that first launch, double-clicking works normally.

#### If macOS says the app is "damaged"

That message appears when the quarantine flag from your browser is still attached. Run this once in Terminal to clear it, then launch normally:

```bash
xattr -cr /Applications/CastLocalVideos.app
```

---

## Use

1. **Launch CastLocalVideos.** A small play icon appears in your menu bar; Chrome opens to the library.
2. **Click "Open Folder"** and pick a folder containing your videos. The app remembers it across sessions.
3. **Click any video to play it locally**, or click the **Cast icon** in the player to send it to a Chromecast on the same Wi-Fi.
4. **Subtitles** load automatically when a `.vtt` or `.srt` file with the same name lives next to the video.
5. **Playlists**: load any `.m3u` file via the toolbar to play a set of videos in order.
6. **Watch progress** is saved automatically — re-open the app and resume where you left off.

### Keyboard shortcuts (in the player)

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Skip 10s |
| `↑` / `↓` | Volume |
| `M` | Mute |
| `F` | Fullscreen |
| `C` | Toggle subtitles |
| `N` / `P` | Next / previous in playlist |
| `0`–`9` | Jump to 0%, 10%, … 90% |

### Quitting

Click the menu-bar icon → **Quit**. Closing Chrome doesn't stop the app — the tray keeps the cast server alive so playback continues on TV.

---

## Cast receiver

The app uses a [custom Cast receiver](https://leocaseiro.github.io/cast-local-videos/receiver.html) hosted on GitHub Pages, registered with Google. The TV shows a styled "Up next" card during playlists and a CC subtitle picker on the remote.

You don't need to do anything for this — the app uses the registered Receiver App ID automatically.

---

## Develop

```bash
git clone git@github.com:leocaseiro/cast-local-videos.git
cd cast-local-videos
npm install

npm run electron     # launch the tray app + open Chrome
# or
npm start            # plain web dev mode (no Electron, no tray)
```

Build distributables:

```bash
npm run dist:mac     # → dist-electron/CastLocalVideos-{arm64,x64}.dmg
npm run dist:win     # Windows installer
npm run dist:linux   # AppImage
```

To publish a release, push a `v*` tag — GitHub Actions builds and uploads automatically:

```bash
git tag v1.0.1 && git push origin v1.0.1
```

### How it works

| Layer | Purpose |
| --- | --- |
| `electron/main.js` | Tray app. Starts both Node servers in-process; opens Google Chrome (the Cast SDK only works in Chrome, not Electron's Chromium). |
| `dev-server.js`   | Static file server on `localhost:8765` serving the sender UI. |
| `server.js`       | Companion server on `localhost:8642`. Receives video uploads from the sender and re-serves them over your LAN so Chromecast can fetch them. Local video files can't be cast directly because Chromecast can't read browser `blob:` URLs. |
| `js/cast.js`      | Google Cast SDK integration. Uses our custom Receiver App ID `2F7F0CDE`. |
| `receiver.html`   | The styled TV-side player (CAF v3 + `<cast-media-player>`). Hosted at `docs/receiver.html` on GitHub Pages. |
