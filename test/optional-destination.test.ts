import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCard, embedJson } from '../public/model.mts';
import { createApp } from '../server.ts';

const card = {
  title: 'standalone card',
  component: { type: 17, components: [{ type: 10, content: 'no redirect needed' }] },
};

test('destinations may be null, missing or blank while invalid values still fail', () => {
  for (const url of [null, undefined, '', '   ']) {
    const value = normalizeCard({ ...card, url });
    assert.equal(value.url, null);
    assert.deepEqual(JSON.parse(embedJson(value)), { component: card.component });
  }
  for (const url of [false, 0, {}, [], 'not a url', 'javascript:alert(1)']) {
    assert.throws(() => normalizeCard({ ...card, url }));
  }
});

test('standalone cards can be created, opened, updated and returned to without a redirect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-optional-destination-'));
  const { server, close } = createApp({
    dbPath: join(directory, 'cards.sqlite'),
    origin: 'https://linkbed.me',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  // The TCP listener has emitted 'listening', so address() returns AddressInfo.
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  let cookie = '';
  const request = (path: string, method = 'GET', data?: unknown) =>
    fetch(base + path, {
      method,
      headers: { origin: 'https://linkbed.me', 'content-type': 'application/json', cookie },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  try {
    const guest = await request('/api/guest', 'POST', {});
    assert.equal(guest.status, 201);
    // The session endpoint returns this cookie on success.
    cookie = (
      guest.headers.getSetCookie().find((value) => value.startsWith('lembed_session=')) as string
    ).split(';')[0];
    const created = await request('/api/cards', 'POST', { ...card, slug: 'standalone', url: null });
    assert.equal(created.status, 201);
    const createdBody: { url: unknown } = await created.json();
    assert.equal(createdBody.url, 'https://linkbed.me/standalone');
    const standalone: { url: unknown } = await (await request('/api/cards/standalone')).json();
    assert.equal(standalone.url, null);
    const listed: { url: unknown }[] = await (await request('/api/cards')).json();
    assert.equal(listed[0].url, null);
    for (const path of ['/standalone', '/p/standalone', '/api/index?card=standalone']) {
      const response = await request(path);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /discord:component-embed/);
      assert.match(html, /no redirect needed/);
      assert.doesNotMatch(html, /src="\/redirect.mjs"|data-redirect|redirect-spinner/);
      assert.match(html, /id="public-card" class="discord-card"/);
      assert.match(html, /src="\/card.mjs"/);
      assert.match(html, /<noscript><article class="published-card"/);
    }
    const publicJson = await request('/api/embeds/standalone');
    assert.equal(publicJson.status, 200);
    assert.deepEqual(await publicJson.json(), { component: card.component });
    assert.equal(
      (await request('/api/cards/standalone', 'PUT', { ...card, url: 'https://example.com/' }))
        .status,
      200,
    );
    assert.match(
      await (await request('/standalone')).text(),
      /data-redirect href="https:\/\/example.com\/"/,
    );
    assert.equal((await request('/api/cards/standalone', 'PUT', { ...card, url: '' })).status, 200);
    const cleared: { url: unknown } = await (await request('/api/cards/standalone')).json();
    assert.equal(cleared.url, null);
    assert.doesNotMatch(
      await (await request('/standalone')).text(),
      /data-redirect|src="\/redirect.mjs"/,
    );
    assert.equal((await request('/api/cards', 'POST', { ...card, slug: 'omitted' })).status, 201);
    const omitted: { url: unknown } = await (await request('/api/cards/omitted')).json();
    assert.equal(omitted.url, null);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
