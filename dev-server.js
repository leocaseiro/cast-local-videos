#!/usr/bin/env node
// Static file server for the CastLocalVideos web app. Zero npm dependencies.
//
// Usage as CLI:    node dev-server.js [port]
// Usage as module: const { startWebServer } = require('./dev-server.js')

const http = require('http');
const fs   = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.webp': 'image/webp',
};

function startWebServer({ port = 8765, root = __dirname, logger = console } = {}) {
  const server = http.createServer((req, res) => {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

    const filePath = path.join(root, urlPath);

    // Prevent path traversal
    if (!filePath.startsWith(root)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });

  server.listen(port, '127.0.0.1', () => {
    logger.log(`CastLocalVideos web app → http://localhost:${port}`);
  });

  return server;
}

module.exports = { startWebServer };

if (require.main === module) {
  const port = parseInt(process.env.PORT || process.argv[2] || '8765', 10);
  const server = startWebServer({ port });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
