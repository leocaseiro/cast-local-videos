#!/usr/bin/env node
/**
 * StreamLocal companion server
 * Receives video files from the browser app and re-serves them over HTTP
 * so Chromecast (on the same LAN) can fetch them.
 *
 * Usage: node server.js [port]
 * Default port: 8642
 */

const http = require('http');
const os   = require('os');
const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');

const PORT = parseInt(process.argv[2] || '8642', 10);
const TEMP = os.tmpdir();

// id -> { tempFile, size, contentType, expires }
const sessions = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const addr of ifaces) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

function sanitizeFilename(name) {
  return path.basename(decodeURIComponent(name)).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function addCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, Range');
}

function serveWithRanges(filePath, fileSize, contentType, req, res) {
  const range = req.headers['range'];
  if (!range) {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const [rawStart, rawEnd] = range.replace(/bytes=/, '').split('-');
  const start = parseInt(rawStart, 10);
  const end   = rawEnd ? parseInt(rawEnd, 10) : fileSize - 1;

  if (start >= fileSize || end >= fileSize || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
    res.end();
    return;
  }

  res.writeHead(206, {
    'Content-Type': contentType,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function pruneExpired() {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (entry.expires < now) {
      try { fs.unlinkSync(entry.tempFile); } catch {}
      sessions.delete(id);
    }
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  addCors(res);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check – web app pings this to know if server is running
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ip: getLocalIP(), port: PORT }));
    return;
  }

  // Upload endpoint – browser POSTs the video file here
  // Headers: X-Filename, Content-Type, Content-Length
  if (req.method === 'POST' && req.url === '/upload') {
    pruneExpired();

    const rawName    = req.headers['x-filename'] || 'video.mp4';
    const filename   = sanitizeFilename(rawName);
    const contentType = req.headers['content-type'] || 'video/mp4';
    const id         = crypto.randomBytes(8).toString('hex');
    const tempFile   = path.join(TEMP, `streamlocal-${id}-${filename}`);

    const writeStream = fs.createWriteStream(tempFile);

    req.on('error', (err) => {
      console.error('Upload error:', err.message);
      try { fs.unlinkSync(tempFile); } catch {}
    });

    req.pipe(writeStream);

    writeStream.on('finish', () => {
      let size = 0;
      try { size = fs.statSync(tempFile).size; } catch {}

      sessions.set(id, {
        tempFile,
        size,
        contentType,
        expires: Date.now() + 2 * 60 * 60 * 1000, // 2h TTL
      });

      const localIP = getLocalIP();
      const castUrl = `http://${localIP}:${PORT}/stream/${id}/${encodeURIComponent(filename)}`;

      console.log(`[cast] ready: ${filename} (${(size / 1024 / 1024).toFixed(1)} MB) → ${castUrl}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ castUrl, id }));
    });

    writeStream.on('error', (err) => {
      console.error('Write error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    });

    return;
  }

  // Stream endpoint – Chromecast fetches video from here
  const match = req.url.match(/^\/stream\/([0-9a-f]+)\//);
  if (req.method === 'GET' && match) {
    const entry = sessions.get(match[1]);
    if (!entry) {
      res.writeHead(404);
      res.end('Not found or expired');
      return;
    }

    let fileSize = entry.size;
    // Refresh size in case a previous stat was wrong
    try { fileSize = fs.statSync(entry.tempFile).size; } catch {}

    serveWithRanges(entry.tempFile, fileSize, entry.contentType, req, res);
    return;
  }

  res.writeHead(404);
  res.end('StreamLocal companion server');
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n🎬  StreamLocal companion server');
  console.log(`    Local:   http://localhost:${PORT}`);
  console.log(`    Network: http://${ip}:${PORT}`);
  console.log('\n    Open the StreamLocal web app and cast away.');
  console.log('    Keep this terminal window open while casting.\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: node server.js 8643`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
