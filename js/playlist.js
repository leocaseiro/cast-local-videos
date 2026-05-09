export function parseM3U(content) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const items = [];
  let pendingTitle = null;
  let pendingDuration = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const match = line.match(/^#EXTINF:(-?\d+(?:\.\d+)?),(.*)$/);
      if (match) {
        pendingDuration = parseFloat(match[1]);
        pendingTitle = match[2].trim();
      }
    } else if (!line.startsWith('#')) {
      items.push({
        path: line,
        title: pendingTitle || fileNameFromPath(line),
        duration: pendingDuration,
      });
      pendingTitle = null;
      pendingDuration = null;
    }
  }

  return items;
}

function fileNameFromPath(path) {
  return path.split(/[/\\]/).pop() || path;
}

export function buildPlaylistFromVideos(videos) {
  return videos.map((v, i) => ({
    index: i,
    title: v.baseName,
    key: v.key,
    video: v,
  }));
}

export function sortVideos(videos, sortBy) {
  const copy = [...videos];
  switch (sortBy) {
    case 'name':
      return copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    case 'size':
      return copy.sort((a, b) => b.size - a.size);
    case 'recent':
      return copy.sort((a, b) => b.lastModified - a.lastModified);
    default:
      return copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
}
