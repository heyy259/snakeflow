import fs from 'node:fs';
import path from 'node:path';

const MIME_BY_EXT = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.map', 'application/json; charset=utf-8'],
]);

export function createStaticHandler({ rootDir }) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const candidate = path.resolve(rootDir, relative);
    const inside = candidate === rootDir || candidate.startsWith(`${rootDir}${path.sep}`);
    const file = inside && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(rootDir, 'index.html');
    if (!fs.existsSync(file)) {
      res.statusCode = 404;
      res.end('dist not built; run npm run build');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME_BY_EXT.get(path.extname(file).toLowerCase()) || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  };
}
