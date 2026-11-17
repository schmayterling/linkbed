import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { normalizeCard } from '../public/model.mjs';

test('missing and suspended pages return the same real 404 while APIs keep JSON errors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-not-found-'));
  const dbPath = join(directory, 'cards.sqlite');
  const { server, close } = createApp({
    dbPath,
    databaseUrl: '',
    origin: 'https://linkbed.me',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await fetch(base + '/healthz');
    const db = new DatabaseSync(dbPath);
    const card = normalizeCard({ title: 'private suspended title', url: null });
    for (const slug of ['active', 'suspended'])
      db.prepare(
        'INSERT INTO cards (slug, owner, card, revision, updated_at) VALUES (?, ?, ?, 1, ?)',
      ).run(slug, 'test', JSON.stringify(card), Date.now());
    db.prepare('INSERT INTO banned_slugs VALUES (?, ?)').run('suspended', Date.now());
    db.close();

    let expected;
    for (const path of [
      '/does-not-exist',
      '/p/does-not-exist',
      '/api/index?card=does-not-exist',
      '/suspended',
      '/p/suspended',
      '/missing/nested',
      '/missing.js',
      '/api/index?notfound=1',
    ]) {
      const response = await fetch(base + path);
      const html = await response.text();
      assert.equal(response.status, 404, path);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.equal(response.headers.get('x-robots-tag'), 'noindex');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('location'), null);
      assert.match(html, /<title>404 \| linkbed<\/title>/);
      assert.match(html, /name="robots" content="noindex"/);
      assert.match(
        html,
        /property="og:description" content="this link does not exist or has been suspended"/,
      );
      assert.match(html, /<h1>404<\/h1>/);
      assert.match(html, /src="\/not-found.gif" alt="" width="498" height="203"/);
      assert.match(html, /href="https:\/\/linkbed.me\/">back to linkbed.me<\/a>/);
      assert.doesNotMatch(html, /private suspended title|discord:component-embed|redirect.mjs/);
      expected ??= html;
      assert.equal(html, expected);
      const head = await fetch(base + path, { method: 'HEAD' });
      assert.equal(head.status, 404);
      assert.equal(head.headers.get('x-robots-tag'), 'noindex');
      assert.equal(await head.text(), '');
    }
    for (const path of ['/api/embeds/suspended', '/api/embeds/does-not-exist', '/api/missing']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 404);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.equal(typeof (await response.json()).error, 'string');
    }
    const active = await fetch(base + '/active');
    assert.equal(active.status, 200);
    assert.match(await active.text(), /discord:component-embed/);
    const image = await fetch(base + '/not-found.gif');
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/gif');
    assert.equal(
      Buffer.from(await image.arrayBuffer())
        .subarray(0, 6)
        .toString(),
      'GIF89a',
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
