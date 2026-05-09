import { srtToVtt } from './subtitles.js';

const RECEIVER_ID = 'CC1AD845'; // Default Media Receiver
const COMPANION_PORT = 8642;
const COMPANION_URL = `http://localhost:${COMPANION_PORT}`;

let castAvailable = false;
let castSession = null;

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

  // The SDK may have already fired __onGCastApiAvailable before this module ran.
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

export async function castMedia(videoUrl, title, subtitleUrl = null, startTime = 0) {
  const session = getCastSession();
  if (!session) {
    const ctx = cast.framework.CastContext.getInstance();
    try {
      await ctx.requestSession();
    } catch {
      return false;
    }
  }

  const s = getCastSession();
  if (!s) return false;

  const mediaInfo = new chrome.cast.media.MediaInfo(videoUrl, 'video/mp4');
  mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
  mediaInfo.metadata.title = title;

  if (subtitleUrl) {
    const track = new chrome.cast.media.Track(1, chrome.cast.media.TrackType.TEXT);
    track.trackContentId = subtitleUrl;
    track.trackContentType = 'text/vtt';
    track.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
    track.name = 'Subtitles';
    mediaInfo.tracks = [track];
  }

  const req = new chrome.cast.media.LoadRequest(mediaInfo);
  if (subtitleUrl) req.activeTrackIds = [1];
  if (startTime > 0) req.currentTime = startTime;

  try {
    await s.loadMedia(req);
    return true;
  } catch {
    return false;
  }
}

export function isLocalUrl(url) {
  return url.startsWith('blob:') || url.startsWith('file:');
}

export async function pingCompanion() {
  try {
    const r = await fetch(`${COMPANION_URL}/ping`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return await r.json(); // { ok, ip, port }
  } catch {
    return null;
  }
}

export function stopCast() {
  if (!castAvailable) return;
  cast.framework.CastContext.getInstance().endCurrentSession(true);
}

export async function uploadSubtitleForCast(fileHandle) {
  const file = await fileHandle.getFile();
  const ext = file.name.split('.').pop().toLowerCase();
  let text = await file.text();
  if (ext === 'srt') text = srtToVtt(text);

  const vttName = file.name.replace(/\.[^.]+$/, '.vtt');
  const blob = new Blob([text], { type: 'text/vtt' });

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${COMPANION_URL}/upload`);
    xhr.setRequestHeader('X-Filename', encodeURIComponent(vttName));
    xhr.setRequestHeader('Content-Type', 'text/vtt');
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('Invalid response from companion server')); }
      } else {
        reject(new Error(`Server error: ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Cannot reach companion server'));
    xhr.send(blob);
  });
}

export async function uploadForCast(fileHandle, onProgress) {
  const file = await fileHandle.getFile();

  // XHR gives us upload progress; fetch with streaming body requires HTTP/2
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
      } else {
        reject(new Error(`Server error: ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error('Cannot reach companion server — is it running? (node server.js)'));
    xhr.send(file);
  });
}
