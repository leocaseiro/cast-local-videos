export const VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'avi', 'mov', 'wmv', 'm4v', 'ogv', 'flv', 'ts', 'm2ts']);
const SUBTITLE_EXTS = new Set(['vtt', 'srt']);

export function videoKey(dirName, relativePath) {
  return `${dirName}::${relativePath}`;
}

export function fileExt(name) {
  return name.split('.').pop().toLowerCase();
}

export function fileBaseName(name) {
  return name.substring(0, name.lastIndexOf('.')) || name;
}

export function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function scanDirectory(dirHandle, rootName, pathPrefix = '', depth = 0) {
  if (depth > 8) return [];
  const videos = [];
  const fileMap = new Map(); // name -> handle, for subtitle matching

  const entries = [];
  for await (const [name, handle] of dirHandle.entries()) {
    entries.push([name, handle]);
  }

  // First pass: collect all files in this dir
  for (const [name, handle] of entries) {
    if (handle.kind === 'file') {
      fileMap.set(name.toLowerCase(), handle);
    }
  }

  // Second pass: process videos and subdirs
  for (const [name, handle] of entries) {
    if (handle.kind === 'file') {
      const ext = fileExt(name);
      if (!VIDEO_EXTS.has(ext)) continue;

      const file = await handle.getFile();
      const relPath = pathPrefix ? `${pathPrefix}/${name}` : name;
      const baseName = fileBaseName(name);

      // Look for subtitle files with same base name
      const subtitles = [];
      for (const subExt of SUBTITLE_EXTS) {
        const subName = `${baseName}.${subExt}`.toLowerCase();
        if (fileMap.has(subName)) {
          subtitles.push({ ext: subExt, handle: fileMap.get(subName), name: `${baseName}.${subExt}` });
        }
      }

      videos.push({
        key: videoKey(rootName, relPath),
        name,
        baseName,
        ext,
        size: file.size,
        lastModified: file.lastModified,
        relPath,
        handle,
        dirHandle,
        rootName,
        subtitles,
        depth,
      });
    } else if (handle.kind === 'directory' && !name.startsWith('.')) {
      const sub = await scanDirectory(handle, rootName, pathPrefix ? `${pathPrefix}/${name}` : name, depth + 1);
      videos.push(...sub);
    }
  }

  return videos;
}

export async function generateThumbnail(fileHandle) {
  return new Promise(async (resolve) => {
    let url = null;
    try {
      const file = await fileHandle.getFile();
      url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'metadata';

      const cleanup = () => { if (url) URL.revokeObjectURL(url); };

      const onSeeked = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 180;
          canvas.getContext('2d').drawImage(video, 0, 0, 320, 180);
          cleanup();
          resolve(canvas.toDataURL('image/jpeg', 0.75));
        } catch {
          cleanup();
          resolve(null);
        }
      };

      video.addEventListener('loadedmetadata', () => {
        video.currentTime = Math.min(5, video.duration * 0.1);
      }, { once: true });

      video.addEventListener('seeked', onSeeked, { once: true });
      video.addEventListener('error', () => { cleanup(); resolve(null); }, { once: true });

      video.src = url;
      video.load();

      setTimeout(() => { cleanup(); resolve(null); }, 8000);
    } catch {
      if (url) URL.revokeObjectURL(url);
      resolve(null);
    }
  });
}
