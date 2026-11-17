import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { destinationUrl, isSelfDestination, normalizeCard } from '../public/model.mjs';
import { renderCard } from '../render.mjs';
import { createApp } from '../server.mjs';

const page = 'https://cards.example.com/here';
const card = { title: 'here', url: 'https://example.com/', color: null, images: [], buttons: [] };

test('self destinations include aliases, encoded paths and query variants', () => {
  for (const url of [
    page,
    page + '/?v=2#preview',
    'https://cards.example.com/p/here',
    'https://linkbed.me/here',
    'https://www.linkbed.me/here',
    'https://linkbed.ryana.dev/p/here',
    'https://LINKBED.ME./%68ere',
    'https://linkbed.me/api/index?card=here',
  ]) {
    assert.equal(isSelfDestination(url, page), true, url);
    assert.throws(() => destinationUrl(url, page), /own link/);
    assert.throws(() => normalizeCard({ ...card, url }, page), /own link/);
  }
  for (const url of [
    'https://example.com/here',
    'https://linkbed.me/elsewhere',
    'https://linkbed.me/',
    'https://linkbed.me/%',
  ]) {
    assert.equal(isSelfDestination(url, page), false, url);
    assert.equal(destinationUrl(url, page), url);
  }
});

test('existing self-linked cards keep their embed without a redirect or self destination', () => {
  const saved = normalizeCard({ ...card, url: 'https://linkbed.me/here' });
  const html = renderCard(saved, page);
  assert.match(html, /discord:component-embed/);
  assert.doesNotMatch(html, /src="\/redirect.mjs"|data-redirect|redirect-spinner/);
  const normal = renderCard(normalizeCard(card), page);
  assert.match(normal, /src="\/redirect.mjs"/);
  assert.match(normal, /data-redirect href="https:\/\/example.com\/"/);
  assert.match(normal, /class="redirect-spinner" aria-hidden="true"/);
  assert.match(normal, /role="status">redirecting to/);
  assert.doesNotMatch(normal, /class="published-card"|class="public-header"/);
  assert.match(normal, /discord:component-embed/);
});

test('api rejects self destinations on creation, update and rename while old cards stay readable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-self-redirect-'));
  const dbPath = join(directory, 'cards.sqlite');
  const { server, close } = createApp({ dbPath, origin: 'https://linkbed.me' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  const request = (path, method = 'GET', data) =>
    fetch(base + path, {
      method,
      headers: { origin: 'https://linkbed.me', 'content-type': 'application/json', cookie },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  try {
    const signup = await request('/api/signup', 'POST', {});
    assert.equal(signup.status, 201);
    cookie = signup.headers
      .getSetCookie()
      .find((value) => value.startsWith('lembed_session='))
      .split(';')[0];
    const blocked = await request('/api/cards', 'POST', {
      ...card,
      slug: 'here',
      url: 'https://linkbed.me/here',
    });
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json()).error, /own link/);
    assert.equal((await request('/api/cards', 'POST', { ...card, slug: 'here' })).status, 201);
    for (const input of [
      { slug: 'here', url: 'https://www.linkbed.me/p/here?v=2' },
      { slug: 'renamed', url: 'https://linkbed.me/renamed' },
    ]) {
      assert.equal((await request('/api/cards/here', 'PUT', { ...card, ...input })).status, 400);
    }
    const unchanged = await (await request('/api/cards/here')).json();
    assert.equal(unchanged.url, card.url);
    assert.equal(unchanged.revision, 1);
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE cards SET card = ? WHERE slug = ?').run(
      JSON.stringify(normalizeCard({ ...card, url: 'https://linkbed.me/here' })),
      'here',
    );
    db.close();
    for (const path of ['/here', '/p/here', '/api/index?card=here']) {
      const response = await request(path);
      assert.equal(response.status, 200);
      assert.doesNotMatch(await response.text(), /src="\/redirect.mjs"|data-redirect/);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
