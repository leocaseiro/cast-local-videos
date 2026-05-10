import { srtToVtt } from './subtitles.js';

// CastLocalVideos custom receiver — registered at https://cast.google.com/publish
// pointing at https://leocaseiro.github.io/cast-local-videos/receiver.html
const RECEIVER_ID = '2F7F0CDE';
// const RECEIVER_ID = 'CC1AD845';

const COMPANION_PORT = 8642;
const COMPANION_URL  = `http://localhost:${COMPANION_PORT}`;

// Queue item IDs encode the playlist index: itemId = playlistIndex + OFFSET
// Using 1-based so itemId 0 (falsy) is never assigned.
const QUEUE_ID_OFFSET = 1;

let castAvailable = false;
let castSession   = null;

export function initCast(onStateChange) {
  function setup(isAvailable) {
    if (!isAvailable) {
      onStateChange('unavailable', null);
      return;
    }
    castAvailable = true;

    const ctx = cast.framework.CastContext.getInstance();
    ctx.setOptions({
      receiverApplicationId: RECEIVER_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });

    ctx.addEventListener(
      cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
      (e) => {
        castSession = ctx.getCurrentSession();
        onStateChange(e.sessionState, castSession);
      }
    );

    onStateChange('available', null);
  }

  if (window.__castApiReady !== undefined) {
    setup(window.__castApiReady);
  } else {
    window.__castCallbacks.push(setup);
  }
}

export function isCastAvailable() { return castAvailable; }

export function getCastSession() {
  if (!castAvailable) return null;
  return cast.framework.CastContext.getInstance().getCurrentSession();
}

export function getCastDeviceName() {
  if (!castAvailable) return null;
  const session = cast.framework.CastContext.getInstance().getCurrentSession();
  return session?.getCastDevice()?.friendlyName || null;
}

// ─── Media loading ─────────────────────────────────────────────────────────

export async function castMedia(videoUrl, title, subtitleUrl = null, startTime = 0, playlistIndex = 0) {
  const session = getCastSession();
  if (!session) {
    const ctx = cast.framework.CastContext.getInstance();
    try { await ctx.requestSession(); } catch { return false; }
  }

  const s = getCastSession();
  if (!s) return false;

  const mediaInfo = _buildMediaInfo(videoUrl, title, subtitleUrl);

  // Wrap in a queue so the receiver shows next/prev controls and "Up next" card
  const queueItem = new chrome.cast.media.QueueItem(mediaInfo);
  queueItem.itemId = playlistIndex + QUEUE_ID_OFFSET;
  if (startTime > 0) queueItem.startTime = startTime;
  if (subtitleUrl) queueItem.activeTrackIds = [1];

  const queueData = new chrome.cast.media.QueueData();
  queueData.items = [queueItem];

  const req = new chrome.cast.media.LoadRequest(mediaInfo);
  req.queueData = queueData;
  if (subtitleUrl) req.activeTrackIds = [1];
  if (startTime > 0) req.currentTime = startTime;

  try { await s.loadMedia(req); return true; } catch { return false; }
}

// Insert the next episode into the existing cast queue.
// Call this after pre-uploading the next video in the background.
export function queueNextItem(castUrl, title, subtitleUrl, playlistIndex) {
  if (!castAvailable) return Promise.resolve();
  const session = getCastSession();
  const media = session?.getMediaSession();
  if (!media) return Promise.resolve();

  const mediaInfo = _buildMediaInfo(castUrl, title, subtitleUrl);
  const item = new chrome.cast.media.QueueItem(mediaInfo);
  item.itemId = playlistIndex + QUEUE_ID_OFFSET;
  item.preloadTime = 20; // receiver starts buffering 20s before current item ends
  if (subtitleUrl) item.activeTrackIds = [1];

  const req = new chrome.cast.media.QueueInsertItemsRequest([item]);
  return new Promise((resolve) => {
    media.queueInsertItems(req, resolve, (err) => {
      console.warn('[cast] queueInsertItems:', err);
      resolve();
    });
  });
}

// ─── Playback controls ─────────────────────────────────────────────────────

export function stopCast() {
  if (!castAvailable) return;
  cast.framework.CastContext.getInstance().endCurrentSession(true);
}

// Toggle the first text track on/off. Returns the new enabled state.
export function toggleCastSubtitles() {
  if (!castAvailable) return false;
  const session = getCastSession();
  const media = session?.getMediaSession();
  if (!media) return false;

  const tracks = media.media?.tracks ?? [];
  const textTrack = tracks.find(t => t.type === chrome.cast.media.TrackType.TEXT);
  if (!textTrack) return false;

  const id = textTrack.trackId;
  const active = media.activeTrackIds ?? [];
  const isOn = active.includes(id);
  const next = isOn ? active.filter(x => x !== id) : [...active, id];

  media.editTracksInfo(new chrome.cast.media.EditTracksInfoRequest(next), null,
    (err) => console.warn('[cast] editTracksInfo:', err));
  return !isOn;
}

// Decode the playlist index from a Cast queue item ID.
export function queueItemIdToIndex(itemId) {
  return itemId - QUEUE_ID_OFFSET;
}

// ─── Companion server uploads ──────────────────────────────────────────────

export async function pingCompanion() {
  try {
    const r = await fetch(`${COMPANION_URL}/ping`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function uploadForCast(fileHandle, onProgress) {
  const file = await fileHandle.getFile();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${COMPANION_URL}/upload`);
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('Invalid response from companion server')); }
      } else { reject(new Error(`Server error: ${xhr.status}`)); }
    };
    xhr.onerror = () => reject(new Error('Cannot reach companion server — is it running? (node server.js)'));
    xhr.send(file);
  });
}

export async function uploadSubtitleForCast(fileHandle) {
  const file = await fileHandle.getFile();
  const ext  = file.name.split('.').pop().toLowerCase();
  let text   = await file.text();
  if (ext === 'srt') text = srtToVtt(text);

  const vttName = file.name.replace(/\.[^.]+$/, '.vtt');
  const blob    = new Blob([text], { type: 'text/vtt' });

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${COMPANION_URL}/upload`);
    xhr.setRequestHeader('X-Filename', encodeURIComponent(vttName));
    xhr.setRequestHeader('Content-Type', 'text/vtt');
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('Invalid response from companion server')); }
      } else { reject(new Error(`Server error: ${xhr.status}`)); }
    };
    xhr.onerror = () => reject(new Error('Cannot reach companion server'));
    xhr.send(blob);
  });
}

export function isLocalUrl(url) {
  return url.startsWith('blob:') || url.startsWith('file:');
}

// ─── Private ───────────────────────────────────────────────────────────────

function _buildMediaInfo(videoUrl, title, subtitleUrl) {
  const info = new chrome.cast.media.MediaInfo(videoUrl, 'video/mp4');
  info.metadata = new chrome.cast.media.GenericMediaMetadata();
  info.metadata.title = title;
  if (subtitleUrl) {
    const track = new chrome.cast.media.Track(1, chrome.cast.media.TrackType.TEXT);
    track.trackContentId  = subtitleUrl;
    track.trackContentType = 'text/vtt';
    track.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
    track.name    = 'Subtitles';
    info.tracks   = [track];
  }
  return info;
}
