import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server.ts';

// The remote-check command requires a path to the database auth file.
const authToken = readFileSync(process.env.DB_AUTH_FILE as string, 'utf8').trim();
const { server, close } = createApp({ databaseUrl: process.env.DATABASE_URL, authToken });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
// This server is already listening on the TCP loopback address specified above.
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const call = (path: string, method = 'GET', data?: unknown, cookie = ''): Promise<Response> =>
  fetch(base + path, {
    method,
    headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', cookie },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
let session;
let token: string | undefined;
const slug = 'remote-check-' + Date.now();
try {
  const response = await call('/api/signup', 'POST', {});
  assert.equal(response.status, 201);
  // Successful signup sets a session cookie.
  session = (
    response.headers.getSetCookie().find((value) => value.startsWith('lembed_session=')) as string
  ).split(';')[0];
  const signup: unknown = await response.json();
  // HTTP 201 from signup includes the issued token.
  ({ token } = signup as { token: string });
  const card = {
    slug,
    title: 'remote database check',
    description: 'temporary check',
    url: 'https://example.com',
    color: '#5865f2',
    buttons: [],
    images: [],
  };
  assert.equal((await call('/api/cards', 'POST', card, session)).status, 201);
  assert.match(await call('/p/' + slug).then((r) => r.text()), /discord:component-embed/);
  assert.equal((await call('/api/logout', 'POST', {}, session)).status, 200);
  const login = await call('/api/login', 'POST', { token });
  assert.equal(login.status, 200);
  // Successful login sets a session cookie.
  session = (
    login.headers.getSetCookie().find((value) => value.startsWith('lembed_session=')) as string
  ).split(';')[0];
  assert.equal((await call('/api/cards/' + slug, 'GET', undefined, session)).status, 200);
  assert.equal((await call('/api/cards/' + slug, 'DELETE', undefined, session)).status, 200);
  console.log('remote database: account, sign-in, publish, SSR, and delete passed');
} finally {
  const { createHash } = await import('node:crypto');
  const { openDatabase } = await import('../database.ts');
  const db = await openDatabase({ databaseUrl: process.env.DATABASE_URL, authToken });
  if (token) {
    const owner = createHash('sha256').update(token).digest('hex');
    await db.batch(
      [
        { sql: 'DELETE FROM cards WHERE owner = ?', args: [owner] },
        { sql: 'DELETE FROM sessions WHERE owner = ?', args: [owner] },
        { sql: 'DELETE FROM accounts WHERE token_hash = ?', args: [owner] },
      ],
      'write',
    );
  }
  db.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await close();
}
