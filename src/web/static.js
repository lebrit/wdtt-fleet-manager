import { readFile } from 'node:fs/promises';

const ASSETS = new Map([
  ['/', { file: new URL('./index.html', import.meta.url), contentType: 'text/html; charset=utf-8' }],
  ['/app.js', { file: new URL('./app.js', import.meta.url), contentType: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: new URL('./styles.css', import.meta.url), contentType: 'text/css; charset=utf-8' }],
]);

export async function serveWebAsset(pathname, response) {
  const asset = ASSETS.get(pathname);
  if (!asset) return false;
  response.writeHead(200, {
    'content-type': asset.contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(await readFile(asset.file));
  return true;
}
