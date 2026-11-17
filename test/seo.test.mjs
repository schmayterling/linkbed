import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeCard,
  cardComponents,
  buildEmbed,
  embedJson,
  payloadBytes,
  seoMetadata,
} from '../public/model.mjs';
import { importCardJson, messageJson } from '../public/interchange.mjs';
import { renderCard, renderEditor } from '../render.mjs';
import { createApp } from '../server.mjs';

const text = (content) => ({ type: 10, content });
const first = {
  type: 17,
  components: [
    text('first card'),
    { type: 12, items: [{ media: { url: 'https://example.com/first.png' } }] },
  ],
};
const chosen = {
  type: 17,
  accent_color: 0xabcdef,
  components: [
    {
      type: 9,
      components: [text('## chosen **body** [open](https://example.com/) & <unsafe>')],
      accessory: { type: 11, media: { url: 'https://example.com/chosen.png' } },
    },
    { type: 12, items: [{ media: { url: 'https://example.com/video.mp4' } }] },
  ],
};
const page = {
  title: 'page title',
  url: null,
  component: first,
  additional_cards: [chosen],
  embed_card: 1,
};
const script = (html, id) =>
  JSON.parse(
    html.match(
      new RegExp('<script id="' + id + '" type="application/json">(.+?)</script>', 's'),
    )[1],
  );

test('embed selection preserves page order, automatic defaults and explicit first selection', () => {
  const normalized = normalizeCard(page);
  assert.equal(normalized.embed_card, 1);
  assert.deepEqual(cardComponents(normalized), [first, chosen]);
  assert.deepEqual(buildEmbed(normalized), { component: chosen });
  assert.deepEqual(JSON.parse(embedJson(normalized)), { component: chosen });
  assert.equal(payloadBytes(normalized), payloadBytes({ component: chosen }));
  for (const embed_card of [undefined, null]) {
    const automatic = normalizeCard({ ...page, embed_card });
    assert.equal('embed_card' in automatic, false);
    assert.deepEqual(buildEmbed(automatic), { component: first });
  }
  assert.equal(normalizeCard({ ...page, embed_card: 0 }).embed_card, 0);
  for (const embed_card of [-1, 2, 0.5, '1', true, {}, []])
    assert.throws(() => normalizeCard({ ...page, embed_card }));
  const legacy = normalizeCard({ title: 'legacy', additional_cards: [chosen], embed_card: 1 });
  assert.equal(cardComponents(legacy)[0].components[0].content, '## legacy');
  assert.deepEqual(buildEmbed(legacy), { component: chosen });
  assert.throws(
    () =>
      normalizeCard({
        title: 'legacy',
        description: 'x'.repeat(4000),
        additional_cards: [chosen],
        embed_card: 1,
      }),
    /3,000-byte/,
  );
});

test('SEO metadata derives chosen text and images, respects overrides and tolerates unfinished drafts', () => {
  const before = structuredClone(page);
  assert.deepEqual(seoMetadata(page), {
    title: page.title,
    description: 'chosen body open & <unsafe>',
    image: 'https://example.com/chosen.png',
  });
  assert.deepEqual(
    seoMetadata({
      ...page,
      description: ' manual description ',
      seo: { title: ' custom title ', image: ' https://example.com/seo.png ' },
    }),
    {
      title: 'custom title',
      description: 'manual description',
      image: 'https://example.com/seo.png',
    },
  );
  assert.deepEqual(page, before);
  for (const draft of [
    null,
    {},
    { component: null },
    {
      component: {
        components: [null, { type: 9, components: 'unfinished' }, { type: 10, content: 7 }],
      },
    },
    { ...page, additional_cards: {}, embed_card: 99 },
  ]) {
    const metadata = seoMetadata(draft);
    for (const key of ['title', 'description', 'image'])
      assert.equal(typeof metadata[key], 'string');
  }
});

test('SEO normalization omits empty overrides and validates titles and image URLs', () => {
  for (const seo of [undefined, null, {}, { title: ' ', image: '' }]) {
    assert.equal('seo' in normalizeCard({ ...page, seo }), false);
  }
  assert.deepEqual(
    normalizeCard({ ...page, seo: { title: ' custom ', image: 'https://EXAMPLE.com/seo.png' } })
      .seo,
    { title: 'custom', image: 'https://example.com/seo.png' },
  );
  normalizeCard({ ...page, seo: { title: 't'.repeat(256) } });
  for (const seo of [
    [],
    false,
    'title',
    { title: 't'.repeat(257) },
    { title: 7 },
    { image: false },
    { image: 'http://example.com/seo.png' },
    { image: 'javascript:alert(1)' },
    { description: 'duplicate field' },
  ]) {
    assert.throws(() => normalizeCard({ ...page, seo }));
  }
});

test('page favicons normalize, omit blank values and render escaped links with the existing fallback', () => {
  const card = normalizeCard({ ...page, seo: { favicon: 'https://EXAMPLE.com/icon.ico?x=1&y=2' } });
  assert.deepEqual(card.seo, { favicon: 'https://example.com/icon.ico?x=1&y=2' });
  assert.deepEqual(importCardJson({ component: first, seo: card.seo }).seo, card.seo);
  assert.match(
    renderCard(card, 'https://linkbed.me/page'),
    /<link rel="icon" href="https:\/\/example.com\/icon.ico\?x=1&amp;y=2">/,
  );
  assert.match(
    renderCard(normalizeCard(page), 'https://linkbed.me/page'),
    /<link rel="icon" href="https:\/\/github.com\/schmayterling.png\?size=64">/,
  );
  for (const favicon of ['', '   ', null, undefined])
    assert.equal('seo' in normalizeCard({ ...page, seo: { favicon } }), false);
  for (const favicon of [
    false,
    7,
    'http://example.com/icon.ico',
    'javascript:alert(1)',
    'https://example.com/' + 'x'.repeat(2048),
  ])
    assert.throws(() => normalizeCard({ ...page, seo: { favicon } }));
});

test('native page backup round-trips supplied SEO and metadata while Discord exports chosen card only', () => {
  const native = {
    ...page,
    description: 'manual description',
    color: '#abcdef',
    seo: {
      title: 'shared title',
      image: 'https://example.com/seo.png',
      favicon: 'https://example.com/icon.ico',
    },
  };
  assert.deepEqual(importCardJson(JSON.stringify(native)), native);
  for (const embed_card of [0, 1]) {
    const value = { component: first, additional_cards: [chosen], embed_card };
    assert.deepEqual(importCardJson(value), value);
  }
  assert.deepEqual(importCardJson({ component: first, embed_card: null, seo: {} }), {
    component: first,
  });
  assert.deepEqual(importCardJson({ component: first }), { component: first });
  for (const invalid of [
    { title: '' },
    { description: 7 },
    { description: 'x'.repeat(4097) },
    { url: 'javascript:alert(1)' },
    { color: 'invalid' },
    { embed_card: 2 },
    { seo: { image: 'javascript:alert(1)' } },
  ])
    assert.throws(() => importCardJson({ ...native, ...invalid }));
  assert.deepEqual(JSON.parse(messageJson(normalizeCard(native))).components, [chosen]);
  assert.deepEqual(JSON.parse(embedJson(normalizeCard(native))), { component: chosen });
});

test('public and homepage OG/Twitter tags use escaped SEO metadata with canonical links and chosen Discord root', () => {
  const card = normalizeCard({
    ...page,
    description: 'manual & <description>',
    seo: { title: 'shared " & <title>', image: 'https://example.com/seo.png?x=1&y=2' },
  });
  for (const html of [
    renderCard(card, 'https://linkbed.me/hello'),
    renderEditor(card, 'https://linkbed.me/'),
  ]) {
    assert.match(html, /property="og:title" content="shared &quot; &amp; &lt;title&gt;"/);
    assert.match(html, /name="twitter:title" content="shared &quot; &amp; &lt;title&gt;"/);
    assert.match(html, /property="og:description" content="manual &amp; &lt;description&gt;"/);
    assert.match(html, /name="twitter:description" content="manual &amp; &lt;description&gt;"/);
    assert.match(html, /property="og:image" content="https:\/\/example.com\/seo.png\?x=1&amp;y=2"/);
    assert.match(
      html,
      /name="twitter:image" content="https:\/\/example.com\/seo.png\?x=1&amp;y=2"/,
    );
    assert.deepEqual(script(html, 'discord:component-embed'), { component: chosen });
    assert.doesNotMatch(
      html,
      /<meta [^>]*content="https:\/\/example.com\/(?:first.png|video.mp4)"/,
    );
  }
  const automatic = renderCard(normalizeCard(page), 'https://linkbed.me/hello');
  assert.match(
    automatic,
    /property="og:description" content="chosen body open &amp; &lt;unsafe&gt;"/,
  );
  assert.match(automatic, /name="twitter:image" content="https:\/\/example.com\/chosen.png"/);
  assert.match(automatic, /rel="canonical" href="https:\/\/linkbed.me\/hello"/);
  assert.deepEqual(script(automatic, 'page-cards'), [first, chosen]);
  assert.match(automatic, /made with linkbed/);
  assert.match(automatic, /id="report-abuse" type="button">report abuse/);
  assert.match(automatic, /id="report-dialog"/);
  assert.match(
    automatic,
    /id="report-url" type="url" value="https:\/\/linkbed.me\/hello" readonly/,
  );
  assert.doesNotMatch(automatic, /paste this page|this site is free|this site is open source/);
});

test('SEO and selected card persist through API with public image guards and unchanged framing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-seo-'));
  const { server, close } = createApp({
    dbPath: join(directory, 'cards.sqlite'),
    databaseUrl: '',
    origin: 'https://linkbed.me',
  });
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
    const guest = await request('/api/guest', 'POST', {});
    assert.equal(guest.status, 201);
    cookie = guest.headers
      .getSetCookie()
      .find((value) => value.startsWith('lembed_session='))
      .split(';')[0];
    const saved = {
      ...page,
      slug: 'seo-card',
      description: 'manual description',
      seo: {
        title: 'shared title',
        image: 'https://example.com/seo.png',
        favicon: 'https://example.com/icon.ico',
      },
    };
    assert.equal((await request('/api/cards', 'POST', saved)).status, 201);
    const stored = await (await request('/api/cards/seo-card')).json();
    assert.deepEqual(stored.seo, saved.seo);
    assert.equal(stored.description, saved.description);
    assert.equal(stored.embed_card, 1);
    assert.deepEqual(await (await request('/api/embeds/seo-card')).json(), { component: chosen });
    const html = await (await request('/seo-card')).text();
    assert.match(html, /property="og:title" content="shared title"/);
    assert.deepEqual(script(html, 'page-cards'), [first, chosen]);
    for (const seo of [
      { image: 'https://127.0.0.1/private.png' },
      { image: 'https://169.254.169.254/private.png' },
      { favicon: 'https://127.0.0.1/private.ico' },
      { favicon: 'https://169.254.169.254/private.ico' },
      { image: 'http://example.com/seo.png' },
      { title: 't'.repeat(257) },
    ]) {
      assert.equal((await request('/api/cards/seo-card', 'PUT', { ...saved, seo })).status, 400);
    }
    assert.deepEqual((await (await request('/api/cards/seo-card')).json()).seo, saved.seo);
    assert.equal(
      (await request('/api/cards/seo-card', 'PUT', { ...saved, embed_card: 0 })).status,
      200,
    );
    assert.equal((await (await request('/api/cards/seo-card')).json()).embed_card, 0);
    assert.equal(
      (
        await request('/api/cards/seo-card', 'PUT', {
          ...saved,
          embed_card: null,
          description: '',
          seo: {},
        })
      ).status,
      200,
    );
    const automatic = await (await request('/api/cards/seo-card')).json();
    assert.equal('seo' in automatic, false);
    assert.equal('embed_card' in automatic, false);
    assert.deepEqual(await (await request('/api/embeds/seo-card')).json(), { component: first });
    assert.equal(
      (await request('/api/cards/seo-card', 'PUT', { ...saved, url: 'https://example.com/' }))
        .status,
      200,
    );
    const redirected = await (await request('/seo-card')).text();
    assert.match(redirected, /data-redirect/);
    assert.doesNotMatch(redirected, /id="page-cards"/);
    assert.equal((await (await request('/api/cards/seo-card')).json()).additional_cards.length, 1);
    for (const path of ['/seo-card', '/api/embeds/seo-card']) {
      const response = await request(path);
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
