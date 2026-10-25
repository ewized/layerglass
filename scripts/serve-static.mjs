import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [app, portText = '8101'] = process.argv.slice(2);
if (!['web', 'site'].includes(app)) throw new Error('Choose web or site.');
const port = Number(portText);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
const root = fileURLToPath(new URL(`../dist/apps/${app}/`, import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.map': 'application/json' };

createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
    const info = await stat(file);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    const headers = { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    let start = 0;
    let end = info.size - 1;
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!match || (!match[1] && !match[2])) { response.writeHead(416).end(); return; }
      start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end || start >= info.size) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    response.writeHead(request.headers.range ? 206 : 200, headers);
    if (request.method === 'HEAD') response.end();
    else createReadStream(file, { start, end }).on('error', () => response.destroy()).pipe(response);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 400).end();
  }
}).listen(port, '0.0.0.0', () => console.log(`Layerglass ${app} preview: http://localhost:${port}`));
