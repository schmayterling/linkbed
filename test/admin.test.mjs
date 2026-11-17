import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { createHandler, isLocalAdminRequest } from '../handler.mjs';
import { normalizeReportLink, normalizeSlug } from '../public/model.mjs';

test('report links accept only card paths on this site and reserve admin', () => {
  const origin = 'http://localhost:3000';
  assert.deepEqual(normalizeReportLink('linkbed.me/p/hello?v=3#preview', origin), {
    slug: 'hello',
    url: 'https://linkbed.me/hello',
  });
  assert.equal(normalizeReportLink(origin + '/hello', origin).slug, 'hello');
  assert.equal(normalizeReportLink('https://www.linkbed.me/hello', origin).slug, 'hello');
  for (const url of [
    'https://example.com/hello',
    'https://linkbed.me.evil.com/hello',
    'https://name:pass@linkbed.me/hello',
    'https://linkbed.me:444/hello',
    'javascript:alert(1)',
    'https://linkbed.me/api/cards',
    'https://linkbed.me/admin',
    'https://linkbed.me/p/admin',
    'https://linkbed.me/a--b',
    'https://linkbed.me/%61dmin',
  ]) {
    assert.throws(() => normalizeReportLink(url, origin), undefined, url);
  }
  for (const slug of ['api', 'healthz', 'admin', 'terms', 'privacy', '404']) {
    assert.throws(() => normalizeSlug(slug));
    assert.throws(() => normalizeReportLink('https://linkbed.me/' + slug, origin));
    assert.throws(() => normalizeReportLink('https://linkbed.me/p/' + slug, origin));
  }
});

test('admin boundary rejects spoofed hosts, proxies, remote clients and non-local listeners', () => {
  const req = { headers: { host: 'localhost:3000' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.ok(isLocalAdminRequest(req, '127.0.0.1'));
  assert.ok(
    isLocalAdminRequest(
      { headers: { host: '[::1]:3000' }, socket: { remoteAddress: '::1' } },
      '::1',
    ),
  );
  assert.ok(
    isLocalAdminRequest(
      { headers: { host: '127.0.0.1:3000' }, socket: { remoteAddress: '::ffff:127.0.0.1' } },
      '127.0.0.1',
    ),
  );
  for (const host of [
    'evil.com',
    'localhost.evil.com',
    '127.0.0.1.evil.com',
    'localhost:3000@evil.com',
    '',
  ]) {
    assert.equal(isLocalAdminRequest({ ...req, headers: { host } }, '127.0.0.1'), false);
  }
  for (const header of [
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
    'cf-connecting-ip',
  ]) {
    assert.equal(
      isLocalAdminRequest(
        { ...req, headers: { ...req.headers, [header]: '127.0.0.1' } },
        '127.0.0.1',
      ),
      false,
    );
  }
  assert.equal(
    isLocalAdminRequest({ ...req, socket: { remoteAddress: '192.168.1.10' } }, '127.0.0.1'),
    false,
  );
  for (const address of ['0.0.0.0', '::', '192.168.1.1', undefined])
    assert.equal(isLocalAdminRequest(req, address), false);
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.equal(isLocalAdminRequest(req, '127.0.0.1'), false);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('serverless handler rejects admin routes before connecting to the database', async () => {
  const handler = createHandler({
    databaseUrl: 'https://unused.invalid',
    origin: 'https://linkbed.ryana.dev',
  });
  for (const url of [
    '/admin',
    '/admin.mjs',
    '/api/admin/cards',
    '/api/admin/reports',
    '/api/index?card=admin',
    '/api/index?route=admin/cards',
  ]) {
    let status, output;
    const res = {
      setHeader() {},
      writeHead(value) {
        status = value;
      },
      end(value) {
        output = value;
      },
    };
    await handler(
      {
        url,
        method: 'GET',
        headers: { host: 'localhost' },
        socket: { remoteAddress: '127.0.0.1' },
      },
      res,
    );
    assert.equal(status, 404, url);
    assert.equal(JSON.parse(output).error, 'page not found.');
  }
  await handler.close();
});

test('abuse reports persist, throttle, and can be dismissed or resolved by local link deletion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-admin-'));
  const dbPath = join(directory, 'cards.sqlite');
  const { server, close } = createApp({ dbPath, origin: 'http://localhost:3000' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'content-type': 'application/json', origin: base };
  const request = (path, method = 'GET', data, extra = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(base + path, { method, headers: { ...headers, ...extra } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const headers = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2)
            headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
        });
      });
      req.on('error', reject);
      req.end(data === undefined ? undefined : JSON.stringify(data));
    });
  let inspect;
  try {
    assert.equal((await request('/healthz')).status, 200);
    inspect = new DatabaseSync(dbPath);
    const insert = inspect.prepare(
      'INSERT INTO cards (slug, owner, card, revision, updated_at) VALUES (?, ?, ?, 1, ?)',
    );
    for (let i = 0; i < 52; i++)
      insert.run(
        'card-' + i,
        'test-owner',
        JSON.stringify({
          title: i === 0 ? '<script>alert(1)</script>' : 'card ' + i,
          url: 'https://example.com/',
        }),
        1000 + i,
      );
    assert.equal((await request('/admin')).status, 200);
    assert.equal((await request('/admin.mjs')).status, 200);
    assert.match(await request('/admin').then((r) => r.text()), /pending abuse reports/);
    for (const path of ['/admin', '/admin.mjs', '/api/admin/cards', '/api/admin/reports']) {
      assert.equal((await request(path, 'GET', undefined, { host: 'evil.com' })).status, 404);
      assert.equal(
        (await request(path, 'GET', undefined, { 'x-forwarded-for': '127.0.0.1' })).status,
        404,
      );
    }
    assert.equal(
      (
        await request('/api/admin/cards/card-0', 'DELETE', undefined, {
          origin: 'https://evil.com',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request('/api/admin/cards/card-0', 'DELETE', undefined, {
          'sec-fetch-site': 'cross-site',
        })
      ).status,
      403,
    );
    const report = (data) =>
      request('/api/reports', 'POST', data, { origin: 'http://localhost:3000' });
    assert.equal(
      (await report({ url: 'https://linkbed.me/card-0', confirmed: false })).status,
      400,
    );
    assert.equal((await report({ url: 'https://evil.com/card-0', confirmed: true })).status, 400);
    assert.equal(
      (await report({ url: 'https://linkbed.me/missing', confirmed: true })).status,
      404,
    );
    assert.equal(
      (await report({ url: 'https://linkbed.me/card-0?v=1', confirmed: true })).status,
      201,
    );
    assert.equal(
      (await report({ url: 'https://linkbed.ryana.dev/p/card-0', confirmed: true })).status,
      201,
    );
    assert.equal((await report({ url: 'https://linkbed.me/card-0', confirmed: true })).status, 429);
    assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM abuse_reports').get().count, 2);
    const reports = await request('/api/admin/reports').then((r) => r.json());
    assert.equal(reports.items.length, 2);
    assert.equal(reports.items[0].url, 'https://linkbed.me/card-0');
    assert.equal(reports.items[0].title, '<script>alert(1)</script>');
    assert.ok(reports.items.every((row) => !Object.hasOwn(row, 'owner')));
    const cards = await request('/api/admin/cards').then((r) => r.json());
    assert.equal(cards.items.length, 50);
    assert.equal(cards.hasMore, true);
    assert.ok(
      cards.items.every((row) => !Object.hasOwn(row, 'owner') && !Object.hasOwn(row, 'card')),
    );
    assert.equal(
      (await request('/api/admin/cards?offset=50').then((r) => r.json())).items.length,
      2,
    );
    assert.equal(
      (await request('/api/admin/cards?q=card-1').then((r) => r.json())).items.length,
      11,
    );
    assert.equal((await request('/api/admin/cards?offset=-1')).status, 400);
    assert.equal((await request('/api/admin/cards?offset=1.5')).status, 400);
    assert.equal((await request('/api/admin/cards?q=' + 'x'.repeat(201))).status, 400);
    assert.equal(
      (await request('/api/admin/reports/' + reports.items[0].id + '/dismiss', 'POST', {})).status,
      200,
    );
    assert.equal((await request('/api/admin/reports').then((r) => r.json())).items.length, 1);
    assert.equal((await request('/api/admin/cards/card-0', 'DELETE')).status, 200);
    assert.equal((await request('/api/admin/reports').then((r) => r.json())).items.length, 0);
    assert.equal((await request('/card-0')).status, 404);
    assert.equal(
      inspect
        .prepare('SELECT COUNT(*) AS count FROM abuse_reports WHERE resolved_at IS NOT NULL')
        .get().count,
      2,
    );
    assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM cards').get().count, 51);
    const signup = await request('/api/signup', 'POST', {}, { origin: 'http://localhost:3000' });
    const token = (await signup.json()).token;
    const session = signup.headers
      .getSetCookie()
      .find((value) => value.startsWith('lembed_session='))
      .split(';')[0];
    const tokens = await request('/api/admin/tokens').then((r) => r.json());
    const tokenHash = tokens.items[0].token_hash;
    assert.notEqual(tokenHash, token);
    assert.equal(tokenHash.length, 64);
    assert.ok(!JSON.stringify(tokens).includes(token));
    const ownerRequest = (path, method, data) =>
      request(path, method, data, { cookie: session, origin: 'http://localhost:3000' });
    const newCard = {
      slug: 'forbidden',
      title: 'test',
      url: 'https://example.com',
      description: '',
      color: '#5865f2',
      buttons: [],
      images: [],
    };
    assert.equal((await request('/api/admin/slugs/forbidden/ban', 'POST', {})).status, 200);
    assert.equal((await ownerRequest('/api/cards', 'POST', newCard)).status, 403);
    assert.equal(
      (await request('/api/admin/slugs').then((r) => r.json())).items[0].slug,
      'forbidden',
    );
    assert.equal((await request('/api/admin/slugs/forbidden/unban', 'POST', {})).status, 200);
    assert.equal((await ownerRequest('/api/cards', 'POST', newCard)).status, 201);
    assert.equal((await request('/forbidden')).status, 200);
    assert.equal((await request('/api/admin/slugs/forbidden/ban', 'POST', {})).status, 200);
    assert.equal((await request('/forbidden')).status, 404);
    assert.equal(
      (await ownerRequest('/api/cards/forbidden', 'PUT', { ...newCard, slug: 'different' })).status,
      403,
    );
    assert.equal((await request('/api/admin/slugs/forbidden/unban', 'POST', {})).status, 200);
    assert.equal((await request('/forbidden')).status, 200);
    assert.equal(
      (await request('/api/admin/tokens/' + tokenHash + '/revoke', 'POST', {})).status,
      200,
    );
    assert.equal((await ownerRequest('/api/cards/forbidden', 'PUT', newCard)).status, 401);
    assert.equal(
      (await request('/api/login', 'POST', { token }, { origin: 'http://localhost:3000' })).status,
      401,
    );
    assert.ok((await request('/api/admin/tokens').then((r) => r.json())).items[0].revoked_at);
  } finally {
    inspect?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
