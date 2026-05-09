import { openDB, db_put, db_get, db_delete, db_getAll, getRecentlyWatched } from './db.js';
import { scanDirectory, generateThumbnail, formatSize } from './scanner.js';
import { parseM3U, buildPlaylistFromVideos, sortVideos } from './playlist.js';
import { Player } from './player.js';
import { initCast, castMedia, isLocalUrl, pingCompanion, uploadForCast, uploadSubtitleForCast, getCastDeviceName, stopCast } from './cast.js';

// ─── State ─────────────────────────────────────────────────────────────────

const state = {
  folders: [],      // { id, name, handle }
  videos: [],       // all scanned VideoEntry[]
  filtered: [],     // after search/filter
  playlist: [],     // current play queue
  currentIndex: -1,
  player: null,
  layout: 'grid',
  sort: 'name',
  castReady: false,
};

// ─── Init ───────────────────────────────────────────────────────────────────

async function init() {
  // UI must always wire up, even if storage fails
  setupLibraryUI();
  setupPlayerUI();
  setupCast();

  // Storage is best-effort (fails in private mode / restricted environments)
  try {
    await openDB();
    await loadSavedFolders();
    renderRecent();
  } catch (err) {
    console.warn('Storage unavailable, running without persistence:', err);
  }

  // Warn if File System Access API is missing (non-Chrome browsers)
  if (!window.showDirectoryPicker) {
    document.getElementById('empty-state').querySelector('p').textContent =
      'File System Access API not supported. Please use Chrome 86+ on desktop.';
  }
}

// ─── Library UI ─────────────────────────────────────────────────────────────

function setupLibraryUI() {
  document.getElementById('open-folder-btn').addEventListener('click', pickFolder);
  document.getElementById('add-folder-btn').addEventListener('click', pickFolder);
  document.getElementById('empty-open-btn').addEventListener('click', pickFolder);

  document.getElementById('load-playlist-btn').addEventListener('click', () => {
    document.getElementById('playlist-file-input').click();
  });
  document.getElementById('playlist-file-input').addEventListener('change', onPlaylistFileSelected);

  document.getElementById('search-input').addEventListener('input', (e) => {
    filterAndRender(e.target.value.trim());
  });

  document.getElementById('sort-select').addEventListener('change', (e) => {
    state.sort = e.target.value;
    filterAndRender(document.getElementById('search-input').value.trim());
  });

  document.querySelectorAll('.view-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-toggle').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.layout = btn.dataset.layout;
      const grid = document.getElementById('video-grid');
      grid.classList.toggle('layout-list', state.layout === 'list');
    });
  });
}

// ─── Player UI ───────────────────────────────────────────────────────────────

function setupPlayerUI() {
  state.player = new Player({
    onEnded: () => playNext(),
    onBack: () => showLibrary(),
  });
  state.player.onPrev = () => playPrev();

  window.addEventListener('videoError', () => {
    const v = state.videos[state.currentIndex];
    if (v) toast(`Couldn't play "${v.name}" — format may not be supported by this browser`, 'error');
  });
}

// ─── Cast ───────────────────────────────────────────────────────────────────

function setCastState(state) {
  for (const btn of document.querySelectorAll('.cast-btn')) {
    btn.dataset.castState = state;
    btn.title = state === 'unavailable'
      ? 'Cast unavailable (requires Chrome + Chromecast on same network)'
      : state === 'connected' ? 'Casting — click to stop' : 'Cast to TV';
  }
}

function setupCast() {
  initCast((sessionState) => {
    if (sessionState === 'available') {
      state.castReady = true;
      setCastState('ready');
    } else if (sessionState === 'SESSION_STARTED' || sessionState === 'SESSION_RESUMED') {
      setCastState('connected');
      if (state.player) {
        state.player.enterCastMode(getCastDeviceName() || 'your TV');
        showPlayer(); // make controls visible; on refresh this auto-shows the player view
      }
    } else if (sessionState === 'SESSION_ENDED') {
      setCastState('ready');
      if (state.player) state.player.exitCastMode();
    } else if (sessionState === 'unavailable') {
      setCastState('unavailable');
    }
  });

  document.getElementById('cast-btn-player').addEventListener('click', castCurrentItem);
  document.getElementById('cast-btn-library').addEventListener('click', castCurrentItem);
}

async function castCurrentItem({ forceNew = false } = {}) {
  // Button click while already casting → stop the session
  if (!forceNew && state.player.isCasting()) {
    stopCast();
    return;
  }

  const item = state.playlist[state.currentIndex];
  if (!item) return;

  // Capture position before upload so the TV starts at the same spot
  const startTime = forceNew ? 0 : (state.player.video?.currentTime || 0);

  const url = state.player.getCurrentUrl();
  const title = item.title || item.video?.name || '';

  if (url && !isLocalUrl(url)) {
    const ok = await castMedia(url, title, null, startTime);
    if (!ok) toast('Failed to cast. Make sure a Chromecast is on the same network.', 'error');
    return;
  }

  // Local file — stream via companion server (Chromecast can't access browser blob: URLs)
  const companion = await pingCompanion();
  if (!companion) {
    toast('Run the companion server first:\n  node server.js\n(in the StreamLocal folder)', 'error');
    return;
  }

  const progressToast = showProgressToast('Uploading to local server…');
  try {
    const { castUrl } = await uploadForCast(
      item.video.handle,
      (pct) => progressToast.update(`Uploading… ${Math.round(pct * 100)}%`)
    );

    // Upload subtitle to companion server so Chromecast can fetch it
    let subCastUrl = null;
    const sub = item.video.subtitles?.[0];
    if (sub) {
      try {
        const { castUrl: sUrl } = await uploadSubtitleForCast(sub.handle);
        subCastUrl = sUrl;
      } catch (err) {
        console.warn('Subtitle upload failed, casting without subtitles:', err.message);
      }
    }

    progressToast.dismiss();
    const ok = await castMedia(castUrl, title, subCastUrl, startTime);
    if (!ok) toast('Cast failed. Make sure a Chromecast is on the same network.', 'error');
  } catch (err) {
    progressToast.dismiss();
    toast(`Upload failed: ${err.message}`, 'error');
  }
}

// ─── Folder management ───────────────────────────────────────────────────────

async function pickFolder() {
  if (!window.showDirectoryPicker) {
    toast('File System Access API not available. Use Chrome 86+ on desktop.', 'error');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });

    // Avoid duplicates
    const existing = state.folders.find(f => f.handle && f.handle.name === handle.name);
    if (existing) {
      await scanFolder(existing);
      return;
    }

    const id = Date.now();
    const folder = { id, name: handle.name, handle };

    // Store the handle itself — FileSystemDirectoryHandle is structured-cloneable
    try { await db_put('folders', { id, name: handle.name, handle }); } catch {}

    state.folders.push(folder);
    renderFolderList();
    await scanFolder(folder);
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('pickFolder error:', err);
      toast(`Could not open folder: ${err.message}`, 'error');
    }
  }
}

async function loadSavedFolders() {
  const saved = await db_getAll('folders');
  for (const row of saved) {
    const folder = { id: row.id, name: row.name, handle: row.handle || null, needsReconnect: !row.handle };
    state.folders.push(folder);
  }
  renderFolderList();

  // Auto-restore folders that still have permission (no user gesture needed)
  for (const folder of state.folders) {
    if (!folder.handle) continue;
    try {
      const perm = await folder.handle.queryPermission({ mode: 'read' });
      if (perm === 'granted') {
        folder.needsReconnect = false;
        renderFolderList();
        await scanFolder(folder);
      } else {
        // Permission needs re-prompting — mark for one-click reconnect
        folder.needsReconnect = true;
        renderFolderList();
      }
    } catch {
      folder.needsReconnect = true;
    }
  }
}

async function reconnectFolder(folder) {
  try {
    if (folder.handle) {
      // Re-request permission for the stored handle (requires user gesture — the click)
      const result = await folder.handle.requestPermission({ mode: 'read' });
      if (result !== 'granted') { toast('Permission denied.', 'error'); return; }
    } else {
      // No stored handle — fall back to picker
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      folder.handle = handle;
      folder.name = handle.name;
      await db_put('folders', { id: folder.id, name: folder.name, handle });
    }
    folder.needsReconnect = false;
    renderFolderList();
    await scanFolder(folder);
  } catch (err) {
    if (err.name !== 'AbortError') toast('Could not reconnect folder.', 'error');
  }
}

async function removeFolder(folder, e) {
  e.stopPropagation();
  await db_delete('folders', folder.id);
  state.folders = state.folders.filter(f => f.id !== folder.id);
  state.videos = state.videos.filter(v => v.rootName !== folder.name);
  renderFolderList();
  filterAndRender(document.getElementById('search-input').value.trim());
}

async function scanFolder(folder) {
  showScanning(true);
  try {
    const found = await scanDirectory(folder.handle, folder.name);
    state.videos = state.videos.filter(v => v.rootName !== folder.name);
    state.videos.push(...found);
    filterAndRender(document.getElementById('search-input').value.trim());
    toast(`Found ${found.length} video${found.length !== 1 ? 's' : ''} in "${folder.name}"`);
  } catch (err) {
    toast('Error scanning folder: ' + err.message, 'error');
  } finally {
    showScanning(false);
  }
}

function showScanning(on) {
  let el = document.getElementById('scanning-indicator');
  if (on && !el) {
    el = document.createElement('div');
    el.id = 'scanning-indicator';
    el.className = 'scanning-state';
    el.innerHTML = '<div class="spinner"></div><p>Scanning folder…</p>';
    document.querySelector('.library-main')?.appendChild(el);
    document.getElementById('empty-state').hidden = true;
    document.getElementById('video-grid').hidden = true;
    document.getElementById('library-toolbar').hidden = true;
  } else if (!on && el) {
    el.remove();
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderFolderList() {
  const ul = document.getElementById('folder-list');
  ul.innerHTML = '';
  for (const folder of state.folders) {
    const li = document.createElement('li');
    li.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none"><path d="M22 19C22 20.1 21.1 21 20 21H4C2.9 21 2 20.1 2 19V5C2 3.9 2.9 3 4 3H9L11 5H20C21.1 5 22 5.9 22 7V19Z" stroke="currentColor" stroke-width="2"/></svg>
      <span>${folder.name}${folder.needsReconnect ? ' ↩' : ''}</span>
      <span class="folder-remove" title="Remove">✕</span>
    `;
    li.querySelector('.folder-remove').addEventListener('click', (e) => removeFolder(folder, e));
    if (folder.needsReconnect) {
      li.title = 'Click to reconnect this folder';
      li.addEventListener('click', () => reconnectFolder(folder));
    } else {
      li.addEventListener('click', () => scanFolder(folder));
    }
    ul.appendChild(li);
  }
}

async function renderRecent() {
  const recent = await getRecentlyWatched(10);
  const ul = document.getElementById('recent-list');
  ul.innerHTML = '';
  for (const prog of recent) {
    const parts = prog.key.split('::');
    const name = parts[parts.length - 1]?.split('/').pop()?.replace(/\.[^.]+$/, '') || prog.key;
    const li = document.createElement('li');
    li.innerHTML = `<span>${name}</span>`;
    li.title = name;
    li.addEventListener('click', () => {
      const video = state.videos.find(v => v.key === prog.key);
      if (video) openPlayer(state.videos.indexOf(video), state.videos);
      else toast('Video not found — reopen its folder first.');
    });
    ul.appendChild(li);
  }
}

function filterAndRender(query = '') {
  let list = [...state.videos];
  if (query) {
    const q = query.toLowerCase();
    list = list.filter(v => v.name.toLowerCase().includes(q) || v.relPath.toLowerCase().includes(q));
  }
  list = sortVideos(list, state.sort);
  state.filtered = list;
  renderVideoGrid(list);
}

async function renderVideoGrid(videos) {
  const grid = document.getElementById('video-grid');
  const empty = document.getElementById('empty-state');
  const toolbar = document.getElementById('library-toolbar');

  if (videos.length === 0) {
    grid.hidden = true;
    toolbar.hidden = true;
    if (state.videos.length === 0) empty.hidden = false;
    return;
  }

  empty.hidden = true;
  toolbar.hidden = false;
  document.getElementById('video-count').textContent = `${videos.length} video${videos.length !== 1 ? 's' : ''}`;

  grid.hidden = false;
  grid.className = `video-grid${state.layout === 'list' ? ' layout-list' : ''}`;
  grid.innerHTML = '';

  const progressMap = {};
  const progs = await db_getAll('progress');
  for (const p of progs) progressMap[p.key] = p;

  for (const video of videos) {
    const prog = progressMap[video.key];
    const pct = prog && prog.duration ? Math.round((prog.position / prog.duration) * 100) : 0;
    const card = buildCard(video, pct, prog?.completed);
    card.addEventListener('click', () => openPlayer(state.filtered.indexOf(video), state.filtered));
    grid.appendChild(card);
  }
}

function buildCard(video, pct = 0, completed = false) {
  const card = document.createElement('div');
  card.className = 'video-card';
  card.dataset.key = video.key;

  const sizeStr = formatSize(video.size);
  const hasSubs = video.subtitles.length > 0;

  card.innerHTML = `
    <div class="card-thumb">
      <div class="card-thumb-placeholder">
        <svg viewBox="0 0 24 24" fill="none"><path d="M5 3L19 12L5 21V3Z" fill="currentColor" opacity="0.4"/></svg>
      </div>
      ${pct > 0 ? `<div class="card-progress"><div class="card-progress-fill" style="width:${pct}%"></div></div>` : ''}
    </div>
    <div class="card-info">
      <div class="card-title" title="${video.name}">${video.baseName}</div>
      <div class="card-meta">${sizeStr} · ${video.ext.toUpperCase()}</div>
      <div class="card-badges">
        ${hasSubs ? '<span class="badge badge-sub">CC</span>' : ''}
        ${completed ? '<span class="badge badge-watched">Watched</span>' : ''}
      </div>
    </div>
  `;

  // Lazy thumbnail via IntersectionObserver
  const thumb = card.querySelector('.card-thumb');
  const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      observer.disconnect();
      loadCardThumbnail(video, thumb);
    }
  }, { threshold: 0.1 });
  observer.observe(card);

  return card;
}

async function loadCardThumbnail(video, thumbEl) {
  try {
    const cached = await db_get('thumbnails', video.key);
    if (cached?.dataUrl) {
      setCardThumb(thumbEl, cached.dataUrl);
      return;
    }
  } catch {}

  const dataUrl = await generateThumbnail(video.handle);
  if (dataUrl) {
    setCardThumb(thumbEl, dataUrl);
    try {
      await db_put('thumbnails', { key: video.key, dataUrl });
    } catch {}
  }
}

function setCardThumb(thumbEl, dataUrl) {
  const placeholder = thumbEl.querySelector('.card-thumb-placeholder');
  if (!placeholder) return;
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = '';
  img.loading = 'lazy';
  placeholder.replaceWith(img);
}

// ─── Playback ─────────────────────────────────────────────────────────────────

function openPlayer(index, videoList) {
  state.playlist = buildPlaylistFromVideos(videoList);
  state.currentIndex = index;

  showPlayer();
  playAtIndex(index);
}

function playAtIndex(index) {
  if (index < 0 || index >= state.playlist.length) return;
  state.currentIndex = index;

  const entry = state.playlist[index].video;
  const casting = state.player.isCasting();
  // In cast mode: load locally (for resume-after-cast) but don't autoplay
  state.player.load(entry, !casting);
  renderPlaylistSidebar();
  renderRecent();

  if (casting) castCurrentItem({ forceNew: true });
}

function playNext() {
  if (state.currentIndex < state.playlist.length - 1) {
    playAtIndex(state.currentIndex + 1);
  } else {
    toast('End of playlist');
  }
}

function playPrev() {
  if (state.player.video.currentTime > 5) {
    state.player.seekTo(0);
  } else if (state.currentIndex > 0) {
    playAtIndex(state.currentIndex - 1);
  }
}

function renderPlaylistSidebar() {
  const ul = document.getElementById('playlist-items');
  ul.innerHTML = '';
  state.playlist.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'playlist-item' + (i === state.currentIndex ? ' active' : '');
    li.innerHTML = `
      <span class="playlist-item-num">${i + 1}</span>
      <div class="playlist-item-info">
        <div class="playlist-item-title" title="${item.title}">${item.title}</div>
        <div class="playlist-item-meta">${item.video.ext.toUpperCase()} · ${formatSize(item.video.size)}</div>
      </div>
      <svg class="playlist-item-playing" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3L19 12L5 21V3Z"/></svg>
    `;
    li.addEventListener('click', () => playAtIndex(i));
    ul.appendChild(li);
  });

  // Scroll active item into view
  const active = ul.querySelector('.active');
  active?.scrollIntoView({ block: 'nearest' });
}

// ─── M3U playlist ─────────────────────────────────────────────────────────────

async function onPlaylistFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const items = parseM3U(text);

  if (!items.length) { toast('No entries found in playlist.', 'error'); return; }

  // Try to match items to loaded videos by filename
  const matched = [];
  for (const item of items) {
    const name = item.path.split(/[/\\]/).pop();
    const video = state.videos.find(v => v.name === name);
    if (video) matched.push(video);
  }

  if (!matched.length) {
    toast(`Playlist loaded but no matching videos found. Open the folder containing the videos first.`, 'error');
  } else {
    toast(`Playlist: ${matched.length} / ${items.length} videos matched`);
    openPlayer(0, matched);
  }

  e.target.value = '';
}

// ─── View switching ───────────────────────────────────────────────────────────

function showLibrary() {
  document.getElementById('library-view').classList.remove('hidden');
  document.getElementById('library-view').classList.add('active');
  document.getElementById('player-view').classList.add('hidden');
  state.player.video.pause();
  renderRecent();
  filterAndRender(document.getElementById('search-input').value.trim());
}

function showPlayer() {
  document.getElementById('library-view').classList.add('hidden');
  document.getElementById('player-view').classList.remove('hidden');
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showProgressToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  return {
    update: (text) => { el.textContent = text; },
    dismiss: () => {
      el.style.animation = 'toast-out 0.3s ease forwards';
      setTimeout(() => el.remove(), 300);
    },
  };
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast${type ? ' toast-' + type : ''}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toast-out 0.3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

init().catch(console.error);

