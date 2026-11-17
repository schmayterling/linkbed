import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler, isLocalAdminRequest, securityHeaders } from './handler.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const staticFiles = {
  '/terms': ['terms.html', 'text/html; charset=utf-8'],
  '/privacy': ['privacy.html', 'text/html; charset=utf-8'],
  '/privacy-emoji.png': ['privacy-emoji.png', 'image/png'],
  '/not-found.gif': ['not-found.gif', 'image/gif'],
  '/legal.mjs': ['legal.mjs', 'text/javascript; charset=utf-8'],
  '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  '/prompt.md': ['prompt.md', 'text/plain; charset=utf-8'],
  '/model.mjs': ['model.mjs', 'text/javascript; charset=utf-8'],
  '/components.mjs': ['components.mjs', 'text/javascript; charset=utf-8'],
  '/interchange.mjs': ['interchange.mjs', 'text/javascript; charset=utf-8'],
  '/icons.mjs': ['icons.mjs', 'text/javascript; charset=utf-8'],
  '/code-editor.mjs': ['code-editor.mjs', 'text/javascript; charset=utf-8'],
  '/emoji-picker.mjs': ['emoji-picker.mjs', 'text/javascript; charset=utf-8'],
  '/emoji-picker.css': ['emoji-picker.css', 'text/css; charset=utf-8'],
  '/vendor/sortable.mjs': ['vendor/sortable.mjs', 'text/javascript; charset=utf-8'],
  '/vendor/emoji-picker.mjs': ['vendor/emoji-picker.mjs', 'text/javascript; charset=utf-8'],
  '/vendor/emoji-database.mjs': ['vendor/emoji-database.mjs', 'text/javascript; charset=utf-8'],
  '/vendor/emoji-picker.css': ['vendor/emoji-picker.css', 'text/css; charset=utf-8'],
  '/vendor/emoji-data.json': ['vendor/emoji-data.json', 'application/json; charset=utf-8'],
  '/icons.svg': ['icons.svg', 'image/svg+xml'],
  '/vendor/codemirror.mjs': ['vendor/codemirror.mjs', 'text/javascript; charset=utf-8'],
  '/vendor/codemirror.css': ['vendor/codemirror.css', 'text/css; charset=utf-8'],
  '/vendor/coloris.mjs': ['vendor/coloris.mjs', 'text/javascript; charset=utf-8'],
  '/vendor/coloris.css': ['vendor/coloris.css', 'text/css; charset=utf-8'],
  '/vendor/chevron-down.svg': ['vendor/chevron-down.svg', 'image/svg+xml'],
  '/vendor/markdown-it.mjs': ['vendor/markdown-it.mjs', 'text/javascript; charset=utf-8'],
  '/redirect.mjs': ['redirect.mjs', 'text/javascript; charset=utf-8'],
  '/card.mjs': ['card.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/paper-grain.svg': ['paper-grain.svg', 'image/svg+xml'],
  '/robots.txt': ['robots.txt', 'text/plain; charset=utf-8'],
};

export function createApp(options = {}) {
  const allowAdmin = (req) =>
    options.localAdmin !== false && isLocalAdminRequest(req, server.address()?.address);
  const handler = createHandler({ ...options, allowAdmin });
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 15000 }, (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const adminFile =
      path === '/admin'
        ? ['admin.html', 'text/html; charset=utf-8']
        : path === '/admin.mjs'
          ? ['admin.mjs', 'text/javascript; charset=utf-8']
          : null;
    if (adminFile && allowAdmin(req) && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(200, {
        ...securityHeaders,
        'content-type': adminFile[1],
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
      });
      return res.end(req.method === 'HEAD' ? undefined : readFileSync(join(root, adminFile[0])));
    }
    if (['GET', 'HEAD'].includes(req.method) && staticFiles[path]) {
      const [file, type] = staticFiles[path];
      res.writeHead(200, { ...securityHeaders, 'content-type': type, 'cache-control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : readFileSync(join(root, 'public', file)));
    }
    return handler(req, res);
  });
  server.on('close', () => handler.close());
  return { server, close: handler.close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const { server } = createApp();
  server.listen(port, host, () => console.log(`linkbed ready at http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
