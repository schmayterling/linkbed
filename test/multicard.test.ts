import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as model from '../public/model.mts';
import { createApp } from '../server.ts';

const text = (content = 'page card'): model.TextComponent => ({ type: 10, content });
const root = <Children extends unknown[]>(
  ...components: Children
): {
  type: 17;
  components: Children;
} => ({ type: 17, components });
const primary = root(text('primary card'));
const extra = root(text('extra </script><script>alert(1)</script>'));
const page = { title: 'page', url: null, component: primary, additional_cards: [extra] };

test('extra page cards normalize independently and stay out of the primary embed', () => {
  const normalized = model.normalizeCard(page);
  assert.deepEqual(normalized.additional_cards, [extra]);
  assert.deepEqual(model.cardComponents(normalized), [primary, extra]);
  assert.deepEqual(JSON.parse(model.embedJson(normalized)), { component: primary });
  assert.equal(model.payloadBytes(normalized), model.payloadBytes({ component: primary }));
  assert.equal(model.MAX_CARDS, 27);
  for (const additional_cards of [undefined, []]) {
    assert.equal('additional_cards' in model.normalizeCard({ ...page, additional_cards }), false);
  }
  const legacy = model.normalizeCard({ title: 'legacy', additional_cards: [extra] });
  assert.deepEqual(legacy.additional_cards, [extra]);
  assert.deepEqual(model.cardComponents(legacy), [model.buildEmbed(legacy).component, extra]);
  for (const additional_cards of [null, {}, 'card', false, [text()], [null]]) {
    assert.throws(() => model.normalizeCard({ ...page, additional_cards }));
  }
  assert.deepEqual(model.normalizeCard({ ...page, url: 'https://example.com/' }).additional_cards, [
    extra,
  ]);
});

test('27 page cards are allowed with byte, component and media caps on each root', () => {
  const full = root(
    {
      type: 12,
      items: Array.from({ length: 10 }, () => ({
        media: { url: 'https://example.com/image.png' },
      })),
    },
    ...Array.from({ length: 38 }, () => ({ type: 14 })),
  );
  const normalized = model.normalizeCard({
    ...page,
    component: full,
    additional_cards: Array(model.MAX_CARDS - 1).fill(full),
  });
  assert.equal(model.cardComponents(normalized).length, model.MAX_CARDS);
  for (const component of model.cardComponents(normalized)) {
    assert.deepEqual(model.componentStats(component), { components: 40, media: 10 });
  }
  const overhead = model.payloadBytes({ component: root(text('')) });
  const exact = root(text('x'.repeat(model.MAX_BYTES - overhead)));
  model.normalizeCard({
    ...page,
    component: exact,
    additional_cards: Array(model.MAX_CARDS - 1).fill(exact),
  });
  for (const additional_cards of [
    Array(model.MAX_CARDS).fill(extra),
    [root(text(exact.components[0].content + 'x'))],
    [root(...Array.from({ length: 40 }, () => ({ type: 14 })))],
    [
      root({
        type: 12,
        items: Array.from({ length: 11 }, () => ({ media: { url: 'https://example.com/i.png' } })),
      }),
    ],
  ]) {
    assert.throws(() => model.normalizeCard({ ...page, additional_cards }));
  }
});

test('multicard create, update, list and public render preserve extras while Discord JSON stays primary', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-multicard-'));
  const { server, close } = createApp({
    dbPath: join(directory, 'cards.sqlite'),
    databaseUrl: '',
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
  const script = (html: string, id: string): unknown =>
    JSON.parse(
      // The selected script is expected in the rendered page and has one capture.
      (
        html.match(
          new RegExp('<script id="' + id + '" type="application/json">(.+?)</script>', 's'),
        ) as RegExpMatchArray
      )[1],
    );
  try {
    const guest = await request('/api/guest', 'POST', {});
    assert.equal(guest.status, 201);
    // The session endpoint returns this cookie on success.
    cookie = (
      guest.headers.getSetCookie().find((value) => value.startsWith('lembed_session=')) as string
    ).split(';')[0];
    assert.equal((await request('/api/cards', 'POST', { ...page, slug: 'multicard' })).status, 201);
    assert.deepEqual((await (await request('/api/cards/multicard')).json()).additional_cards, [
      extra,
    ]);
    assert.deepEqual((await (await request('/api/cards')).json())[0].additional_cards, [extra]);
    for (const path of ['/multicard', '/p/multicard', '/api/index?card=multicard']) {
      const response = await request(path);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.deepEqual(script(html, 'discord:component-embed'), { component: primary });
      assert.deepEqual(script(html, 'page-cards'), [primary, extra]);
      assert.doesNotMatch(html, /<script>alert|data-redirect|src="\/redirect.mjs"/);
      assert.match(html, /id="public-card" class="discord-card"/);
    }
    assert.deepEqual(await (await request('/api/embeds/multicard')).json(), { component: primary });
    const updated = { ...page, additional_cards: [root(text('second')), extra] };
    assert.equal((await request('/api/cards/multicard', 'PUT', updated)).status, 200);
    assert.deepEqual(
      (await (await request('/api/cards/multicard')).json()).additional_cards,
      updated.additional_cards,
    );
    const redirected = await request('/api/cards/multicard', 'PUT', {
      ...page,
      url: 'https://example.com/',
    });
    assert.equal(redirected.status, 200);
    assert.deepEqual((await (await request('/api/cards/multicard')).json()).additional_cards, [
      extra,
    ]);
    const redirectHtml = await (await request('/multicard')).text();
    assert.match(redirectHtml, /redirect-spinner/);
    assert.doesNotMatch(redirectHtml, /id="page-cards"/);
    assert.equal(
      (
        await request('/api/cards', 'POST', {
          ...page,
          slug: 'too-many',
          additional_cards: Array(model.MAX_CARDS).fill(extra),
        })
      ).status,
      400,
    );
    for (const component of [
      root({
        type: 1,
        components: [{ type: 2, style: 5, label: 'private', url: 'https://127.0.0.1/' }],
      }),
      root({ type: 12, items: [{ media: { url: 'http://10.0.0.1/private.png' } }] }),
      root({
        type: 9,
        components: [text()],
        accessory: { type: 11, media: { url: 'http://169.254.169.254/image.png' } },
      }),
    ]) {
      const response = await request('/api/cards/multicard', 'PUT', {
        ...page,
        additional_cards: [component],
      });
      assert.equal(response.status, 400);
      const body: { error: string } = await response.json();
      assert.match(body.error, /private network/);
    }
    const large = root(text('x'.repeat(2800)));
    const largePage = {
      ...page,
      component: large,
      additional_cards: Array(model.MAX_CARDS - 1).fill(large),
    };
    assert.ok(Buffer.byteLength(JSON.stringify(largePage)) > 65536);
    assert.equal((await request('/api/cards/multicard', 'PUT', largePage)).status, 200);
    assert.equal(
      (await (await request('/api/cards/multicard')).json()).additional_cards.length,
      model.MAX_CARDS - 1,
    );
    assert.equal(
      // The page-cards script contains the rendered page's ordered array of cards.
      (script(await (await request('/multicard')).text(), 'page-cards') as unknown[]).length,
      model.MAX_CARDS,
    );
    assert.equal(
      (
        await request('/api/cards/multicard', 'PUT', {
          ...page,
          padding: 'x'.repeat(model.MAX_PAGE_BYTES),
        })
      ).status,
      413,
    );
    assert.equal((await request('/api/guest', 'POST', { padding: 'x'.repeat(17000) })).status, 413);
    assert.equal(
      (
        await request('/api/cards/multicard', 'PUT', {
          ...page,
          additional_cards: [],
          url: 'https://example.com/',
        })
      ).status,
      200,
    );
    assert.equal(
      'additional_cards' in (await (await request('/api/cards/multicard')).json()),
      false,
    );
    const redirect = await (await request('/multicard')).text();
    assert.match(redirect, /data-redirect/);
    assert.doesNotMatch(redirect, /id="page-cards"/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
