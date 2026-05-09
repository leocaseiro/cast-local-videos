export function srtToVtt(srt) {
  const text = srt.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = text.trim().split(/\n{2,}/);
  let vtt = 'WEBVTT\n\n';

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    let i = 0;
    // Skip numeric index line
    if (/^\d+$/.test(lines[i].trim())) i++;
    if (i >= lines.length) continue;

    const timing = lines[i];
    if (!timing.includes('-->')) continue;

    const vttTiming = timing.replace(/,(\d{3})/g, '.$1');
    const content = lines.slice(i + 1).join('\n').trim();
    if (content) vtt += `${vttTiming}\n${content}\n\n`;
  }

  return vtt;
}

export async function loadSubtitleHandle(handle, videoEl, label) {
  const file = await handle.getFile();
  const text = await file.text();
  const ext = handle.name.split('.').pop().toLowerCase();

  const vttContent = ext === 'srt' ? srtToVtt(text) : text;
  const blob = new Blob([vttContent], { type: 'text/vtt' });
  const url = URL.createObjectURL(blob);

  return addTrack(videoEl, url, label);
}

export function addTrack(videoEl, url, label = 'Subtitles', lang = 'und') {
  // Remove any previous dynamically added tracks with same label
  for (const track of Array.from(videoEl.querySelectorAll('track[data-dynamic]'))) {
    if (track.label === label) {
      URL.revokeObjectURL(track.src);
      track.remove();
    }
  }

  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = label;
  track.srclang = lang;
  track.src = url;
  track.dataset.dynamic = '1';
  track.default = false;
  videoEl.appendChild(track);
  return track;
}

export function clearTracks(videoEl) {
  for (const track of Array.from(videoEl.querySelectorAll('track[data-dynamic]'))) {
    URL.revokeObjectURL(track.src);
    track.remove();
  }
}

export function disableAllTracks(videoEl) {
  for (const track of Array.from(videoEl.textTracks)) {
    track.mode = 'disabled';
  }
}

export function enableTrack(videoEl, index) {
  const tracks = Array.from(videoEl.textTracks);
  tracks.forEach((t, i) => { t.mode = i === index ? 'showing' : 'disabled'; });
}
