import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import type { AddressInfo, Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_BADGES,
  MAX_CARDS,
  MAX_CUSTOM_BADGES,
  normalizeCustomBadges,
  normalizeCard,
  normalizeComponent,
  normalizePageCard,
  isBadgeCase,
  selectedEmbedIndex,
  cardComponents,
  componentUrls,
  buildEmbed,
  embedJson,
  embedScript,
  seoMetadata,
} from '../public/model.mts';
import type {
  Badge,
  BadgeCase,
  ContainerComponent,
  GalleryComponent,
  Page,
  PageSource,
  TextComponent,
} from '../public/model.mts';
import { importCardJson, messageJson } from '../public/interchange.mts';
import { createApp } from '../server.ts';
import { createHandler } from '../handler.ts';
import { openDatabase } from '../database.ts';
import type { Database } from '../database.ts';

type Handler = ReturnType<typeof createHandler>;
type AdminRejectionHandler = Handler & {
  (
    req: Parameters<Handler>[0],
    res: {
      setHeader(): void;
      writeHead(status: number): void;
      end(body: string): void;
    },
  ): ReturnType<Handler>;
};

type AdminBadgeList = { items: { slug: unknown; customBadges: unknown; verified_at: unknown }[] };
type OwnerBadgeRow = { slug: unknown; badges: unknown };
type DiscordFixture = ContainerComponent & { components: [TextComponent, GalleryComponent] };

function listeningPort(server: Server): number {
  // Callers wait for 'listening' on a TCP server before reading its address.
  return (server.address() as AddressInfo).port;
}

const normal = (
  content = 'discord text',
  image = 'https://example.com/discord.png',
): DiscordFixture => ({
  type: 17,
  components: [
    { type: 10, content },
    { type: 12, items: [{ media: { url: image } }] },
  ],
});
const badge = {
  image: 'https://example.com/badge.gif',
  url: 'http://example.com/',
  label: 'alt text',
};
const badgeCase = <Item = Badge>(
  badges: (Badge | Item)[] = [badge],
): {
  type: 'badge_case';
  title: string;
  badges: (Badge | Item)[];
} => ({ type: 'badge_case', title: 'badge case', badges });
const page = <Root>(roots: Root[], extras: Record<string, unknown> = {}) => ({
  title: 'page',
  component: roots[0],
  ...(roots.length > 1 ? { additional_cards: roots.slice(1) } : {}),
  ...extras,
});

test('badge cases normalize strict page-only fields and independent limits', () => {
  assert.equal(MAX_BADGES, 40);
  assert.equal(isBadgeCase(null), false);
  assert.equal(isBadgeCase(normal()), false);
  const normalized = normalizePageCard({
    type: 'badge_case',
    badges: [{ image: 'https://EXAMPLE.com/badge.gif', url: 'http://EXAMPLE.com', label: ' alt ' }],
  });
  assert.deepEqual(normalized, {
    type: 'badge_case',
    title: 'badge case',
    badges: [{ ...badge, label: 'alt' }],
  });
  assert.equal(isBadgeCase(normalized), true);
  assert.equal(
    // Normalization of the badge-case fixture preserves its root type.
    (normalizePageCard({ ...badgeCase(), title: '  ' }) as BadgeCase).title,
    'badge case',
  );
  assert.deepEqual(normalizePageCard(normal()), normal());
  assert.deepEqual(componentUrls(normalized), [badge.image, badge.url]);
  assert.deepEqual(componentUrls(badgeCase([{ image: badge.image }])), [badge.image]);
  const longUrl = 'https://example.com/' + 'x'.repeat(2028);
  assert.equal(longUrl.length, 2048);
  normalizePageCard({
    ...badgeCase(Array(MAX_BADGES).fill({ image: longUrl, url: longUrl, label: 'x'.repeat(80) })),
    title: 'x'.repeat(256),
  });
  for (const value of [
    { ...badgeCase(), extra: true },
    { ...badgeCase(), title: null },
    { ...badgeCase(), title: 'x'.repeat(257) },
    { ...badgeCase(), description: null },
    { ...badgeCase(), description: 'x'.repeat(4097) },
    ...['#123456', -1, 0x1000000, 1.5].map((accent_color) => ({ ...badgeCase(), accent_color })),
    ...['true', 1, null].map((spoiler) => ({ ...badgeCase(), spoiler })),
    ...[undefined, null, {}, [], Array(MAX_BADGES + 1).fill(badge)].map((badges) => ({
      ...badgeCase(),
      badges,
    })),
    ...[
      null,
      [],
      {},
      { ...badge, extra: true },
      { ...badge, image: null },
      { ...badge, image: 'data:image/png;base64,AA==' },
      { ...badge, image: longUrl + 'x' },
      { ...badge, image: 'https://example.com/' + '界'.repeat(300) },
      { ...badge, url: null },
      { ...badge, url: 'javascript:alert(1)' },
      { ...badge, url: longUrl + 'x' },
      { ...badge, label: null },
      { ...badge, label: 'x'.repeat(81) },
    ].map((value) => badgeCase([value])),
  ]) {
    assert.throws(() => normalizePageCard(value), { status: 400 });
  }
  assert.throws(() => normalizeComponent(badgeCase()), { status: 400 });
  assert.throws(() => normalizeComponent({ type: 17, components: [badgeCase()] }), { status: 400 });
});

test('email clickies stay page-only and cannot carry email headers', () => {
  const email = { ...badge, url: 'mailto:hey@ryanaque.com' };
  // The fixture is a badge case with an email badge.
  const root = normalizePageCard(badgeCase([email])) as BadgeCase;
  assert.equal(root.badges[0].url, email.url);
  assert.deepEqual(componentUrls(root), [badge.image]);
  assert.deepEqual(cardComponents(importCardJson(page([normal(), root])))[1], root);
  for (const url of [
    'mailto:',
    'mailto:a@b',
    'mailto:a@example.com?subject=test',
    'mailto:a@example.com%0d%0aBcc:evil@example.com',
    'mailto:a@example.com,b@example.com',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => normalizePageCard(badgeCase([{ ...badge, url }])), { status: 400 });
  }
  assert.throws(
    () =>
      normalizeComponent({
        type: 17,
        components: [
          { type: 1, components: [{ type: 2, style: 5, label: 'mail', url: email.url }] },
        ],
      }),
    { status: 400 },
  );
});

test('badge cards preserve shared appearance and descriptions without affecting link previews', () => {
  const first = normal();
  for (const accent_color of [null, 0, 0xabcdef]) {
    for (const spoiler of [false, true]) {
      const root = {
        ...badgeCase(),
        accent_color,
        spoiler,
        description: '**my collection**\n\n[visit](https://example.com)',
      };
      assert.deepEqual(normalizePageCard(root), root);
      assert.deepEqual(normalizeComponent({ ...first, accent_color, spoiler }), {
        ...first,
        accent_color,
        spoiler,
      });
      const card = normalizeCard(page([root, first]));
      assert.deepEqual(cardComponents(card), [root, first]);
      assert.deepEqual(cardComponents(importCardJson(JSON.stringify(card))), [root, first]);
      assert.deepEqual(JSON.parse(embedJson(card)), { component: first });
      assert.equal(seoMetadata(card).description, seoMetadata(page([first])).description);
    }
  }
  assert.equal(
    // The supplied badge-case root keeps its description field.
    (normalizePageCard({ ...badgeCase(), description: '' }) as BadgeCase).description,
    '',
  );
});

test('mixed root order remains actual page order; automatic embed picks first Discord root', () => {
  const first = normal('first');
  const last = normal('last');
  for (const roots of [
    [badgeCase(), first, last],
    [first, badgeCase(), last],
    [badgeCase(), badgeCase(), first, badgeCase(), last],
  ]) {
    for (const embed_card of [undefined, null]) {
      const card = normalizeCard(page(roots, { embed_card }));
      assert.deepEqual(cardComponents(card), roots);
      assert.equal('embed_card' in card, false);
      assert.equal(selectedEmbedIndex(card), roots.indexOf(first));
      assert.deepEqual(buildEmbed(card), { component: first });
      assert.deepEqual(JSON.parse(embedJson(card)), { component: first });
    }
    for (let embed_card = 0; embed_card < roots.length; embed_card++) {
      if (isBadgeCase(roots[embed_card])) {
        assert.throws(() => normalizeCard(page(roots, { embed_card })), { status: 400 });
      } else {
        const card = normalizeCard(page(roots, { embed_card }));
        assert.equal(card.embed_card, embed_card);
        assert.equal(selectedEmbedIndex(card), embed_card);
        const message: { components: unknown } = JSON.parse(messageJson(card));
        assert.deepEqual(message.components, [roots[embed_card]]);
      }
    }
  }
  const legacy = normalizeCard({ title: 'legacy', additional_cards: [badgeCase()], embed_card: 0 });
  assert.equal(legacy.embed_card, 0);
  assert.equal(selectedEmbedIndex(legacy), 0);
  assert.throws(
    () => normalizeCard({ title: 'legacy', additional_cards: [badgeCase()], embed_card: 1 }),
    { status: 400 },
  );
  assert.equal(
    cardComponents(normalizeCard(page([badgeCase(), ...Array(MAX_CARDS - 1).fill(first)]))).length,
    MAX_CARDS,
  );
  assert.throws(() => normalizeCard(page([badgeCase(), ...Array(MAX_CARDS).fill(first)])));
  for (const roots of [[badgeCase()], [badgeCase(), badgeCase()]])
    assert.throws(() => normalizeCard(page(roots)), /at least one discord card/);
});

test('Discord exports and automatic SEO never select badge roots, including unfinished drafts', () => {
  const first = normal('first');
  const last = normal('last', 'https://example.com/last.png');
  const roots = [badgeCase(), first, badgeCase(), last];
  for (const embed_card of [null, 3]) {
    const card = normalizeCard(page(roots, { embed_card }));
    const selected = embed_card === 3 ? last : first;
    assert.deepEqual(JSON.parse(embedJson(card)), { component: selected });
    const message: { components: unknown } = JSON.parse(messageJson(card));
    assert.deepEqual(message.components, [selected]);
    assert.ok(!embedScript(card).includes('badge_case'));
    assert.equal(seoMetadata(card).description, selected.components[0].content);
    assert.equal(seoMetadata(card).image, selected.components[1].items[0].media.url);
  }
  for (const embed_card of [0, 2, -1, 99, 0.5, '3', {}, null, undefined]) {
    const draft = page(roots, { embed_card });
    assert.equal(selectedEmbedIndex(draft), 1);
    assert.deepEqual(JSON.parse(embedJson(draft)), { component: first });
  }
  assert.equal(selectedEmbedIndex(null), -1);
  assert.equal(selectedEmbedIndex({}), -1);
  const onlyBadges = page([badgeCase(), badgeCase()]);
  assert.equal(selectedEmbedIndex(onlyBadges), -1);
  assert.equal(buildEmbed(onlyBadges).component, undefined);
  assert.equal(embedJson(onlyBadges), '{}');
  assert.equal(seoMetadata(onlyBadges).image, '');
  assert.throws(() => messageJson(onlyBadges));
  for (const root of [badgeCase(), { type: 'unknown_card' }]) {
    // This intentionally passes an unsupported root to exercise serializer behavior from JavaScript.
    assert.equal(embedJson(page([root]) as PageSource), '{}');
    const nested: { type: 17; components: unknown[] } = { type: 17, components: [root] };
    // The serializer receives the same invalid nested child through each entry point.
    assert.throws(() => embedJson({ component: nested as ContainerComponent }), /component type/);
    // The invalid child must also fail in the embed script serializer.
    assert.throws(() => embedScript({ component: nested as ContainerComponent }), /component type/);
    // Discord message export handles the same malformed container.
    assert.throws(() => messageJson({ component: nested as ContainerComponent }));
  }
});

test('native backups preserve badge roots and positions while raw Discord import stays strict', () => {
  const roots = [badgeCase(), normal('first'), badgeCase([{ image: badge.image }]), normal('last')];
  for (const embed_card of [null, 3]) {
    const native = page(roots, {
      embed_card,
      description: 'page description',
      url: null,
      color: '#abcdef',
      seo: { title: 'search title' },
      page_theme: 'dark',
    });
    const expected: Partial<Page> = normalizeCard(native);
    delete expected.buttons;
    delete expected.images;
    for (const data of [native, { backups: [native] }]) {
      const imported = importCardJson(JSON.stringify(data));
      assert.deepEqual(imported, expected);
      assert.deepEqual(cardComponents(imported), roots);
      const message: { components: unknown } = JSON.parse(messageJson(imported));
      assert.deepEqual(message.components, [roots[embed_card === 3 ? 3 : 1]]);
    }
  }
  for (const data of [
    badgeCase(),
    { components: roots },
    { embeds: [{ type: 'components', components: roots }] },
    { messages: [{ data: { flags: 32768, components: roots } }] },
  ])
    assert.throws(() => importCardJson(data), { status: 400 });
});

test('temporary-db API saves mixed content, preserves selection and rejects private badge URLs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-badge-case-'));
  const { server, close } = createApp({
    dbPath: join(directory, 'cards.sqlite'),
    databaseUrl: '',
    origin: 'https://linkbed.me',
    localAdmin: false,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + listeningPort(server);
  let cookie = '';
  const request = (path: string, method = 'GET', data?: unknown) =>
    fetch(base + path, {
      method,
      headers: { origin: 'https://linkbed.me', 'content-type': 'application/json', cookie },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const script = (html: string, id: string): unknown =>
    JSON.parse(
      // The render fixtures emit the requested script with one JSON capture.
      (
        html.match(
          new RegExp('<script id="' + id + '" type="application/json">(.+?)</script>', 's'),
        ) as RegExpMatchArray
      )[1],
    );
  try {
    const guest = await request('/api/guest', 'POST', {});
    assert.equal(guest.status, 201);
    cookie = guest.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const first = normal('first');
    const last = normal('last');
    const roots = [
      {
        ...badgeCase(),
        accent_color: 0xabcdef,
        spoiler: true,
        description: '**page-only collection**',
      },
      first,
      badgeCase([{ ...badge, url: 'mailto:hey@ryanaque.com' }]),
      last,
    ];
    const response = await request('/api/cards', 'POST', {
      ...page(roots),
      slug: 'badge-case',
    });
    assert.equal(response.status, 201);
    const published: { script: string } = await response.json();
    assert.deepEqual(script(published.script, 'discord:component-embed'), {
      component: first,
    });
    let stored: Page = await (await request('/api/cards/badge-case')).json();
    assert.deepEqual(cardComponents(stored), roots);
    assert.equal('embed_card' in stored, false);
    const cards: Page[] = await (await request('/api/cards')).json();
    assert.deepEqual(cardComponents(cards[0]), roots);
    assert.deepEqual(await (await request('/api/embeds/badge-case')).json(), { component: first });
    const html = await (await request('/badge-case')).text();
    assert.deepEqual(script(html, 'page-cards'), roots);
    assert.deepEqual(script(html, 'discord:component-embed'), { component: first });
    assert.equal(
      (await request('/api/cards/badge-case', 'PUT', page(roots, { embed_card: 3 }))).status,
      200,
    );
    stored = await (await request('/api/cards/badge-case')).json();
    assert.equal(stored.embed_card, 3);
    assert.deepEqual(await (await request('/api/embeds/badge-case')).json(), { component: last });
    const hostile = [
      'http://127.0.0.1/x',
      'https://10.0.0.1/x',
      'https://172.16.0.1/x',
      'https://192.168.0.1/x',
      'https://169.254.169.254/x',
      'https://0x7f000001/x',
      'https://2130706433/x',
      'http://[::ffff:127.0.0.1]/x',
      'http://localhost/x',
      'http://host.internal/x',
    ];
    for (const field of ['image', 'url']) {
      for (const url of hostile) {
        for (const badgeFirst of [true, false]) {
          const unsafe = badgeCase([{ ...badge, [field]: url }]);
          const rejected = await request(
            '/api/cards/badge-case',
            'PUT',
            page(badgeFirst ? [unsafe, first] : [first, unsafe]),
          );
          assert.equal(rejected.status, 400, field + ': ' + url);
        }
      }
    }
    for (const data of [
      page([badgeCase()]),
      page(roots, { embed_card: 0 }),
      page([first, badgeCase([])]),
    ])
      assert.equal((await request('/api/cards/badge-case', 'PUT', data)).status, 400);
    assert.deepEqual(await (await request('/api/cards/badge-case')).json(), stored);
    const reordered = [first, badgeCase(), last];
    assert.equal(
      (await request('/api/cards/badge-case', 'PUT', page(reordered, { embed_card: 0 }))).status,
      200,
    );
    stored = await (await request('/api/cards/badge-case')).json();
    assert.equal(stored.embed_card, 0);
    assert.deepEqual(cardComponents(stored), reordered);
    assert.deepEqual(await (await request('/api/embeds/badge-case')).json(), { component: first });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('custom header badges require strict named HTTPS images and cannot enter editable card JSON', () => {
  assert.equal(MAX_CUSTOM_BADGES, 20);
  for (const value of [null, undefined, []]) assert.deepEqual(normalizeCustomBadges(value), []);
  assert.deepEqual(normalizeCustomBadges([{ name: ' one ', image: 'https://EXAMPLE.com/one' }]), [
    { name: 'one', image: 'https://example.com/one' },
  ]);
  const badge = { name: 'x'.repeat(80), image: 'https://example.com/' + 'x'.repeat(2028) };
  assert.equal(
    normalizeCustomBadges(Array(MAX_CUSTOM_BADGES).fill(badge)).length,
    MAX_CUSTOM_BADGES,
  );
  for (const value of [
    {},
    'badges',
    Array(MAX_CUSTOM_BADGES + 1).fill(badge),
    ...[
      null,
      [],
      {},
      { ...badge, extra: true },
      { ...badge, name: '' },
      { ...badge, name: '  ' },
      { ...badge, name: null },
      { ...badge, name: 'x'.repeat(81) },
      { ...badge, image: null },
      { ...badge, image: 'http://example.com/one' },
      { ...badge, image: 'javascript:alert(1)' },
      { ...badge, image: badge.image + 'x' },
      { ...badge, image: 'https://name:password@example.com/one' },
      { ...badge, image: 'https://example.com:444/one' },
    ].map((value) => [value]),
  ])
    assert.throws(() => normalizeCustomBadges(value), { status: 400 });
  const card = normalizeCard({
    ...page([normal()]),
    custom_badges: JSON.stringify([badge]),
    customBadges: [badge],
    verified_at: 1,
    verified: true,
    sponsored_at: 1,
  });
  for (const field of ['custom_badges', 'customBadges', 'verified_at', 'verified', 'sponsored_at'])
    assert.equal(field in card, false);
});

test('new header metadata routes reject non-admin callers before connecting to database', async () => {
  // Denying this route only requires the response methods used to send the rejection.
  const handler = createHandler({ databaseUrl: 'https://unused.invalid' }) as AdminRejectionHandler;
  try {
    for (const [method, route] of [
      ['PUT', 'badges'],
      ['POST', 'verify'],
      ['DELETE', 'verify'],
    ]) {
      let status: number | undefined;
      await handler(
        // Denied admin routes read only these request fields.
        {
          url: '/api/admin/cards/test/' + route,
          method,
          headers: { host: 'localhost' },
          socket: { remoteAddress: '127.0.0.1' },
        } as Parameters<typeof handler>[0],
        {
          setHeader() {},
          writeHead(value: number) {
            status = value;
          },
          end() {},
        },
      );
      assert.equal(status, 404);
    }
  } finally {
    await handler.close();
  }
});

test('header badge migrations preserve old records and reopen with nullable columns', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-header-migration-'));
  const dbPath = join(directory, 'cards.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(
    'CREATE TABLE cards (slug TEXT PRIMARY KEY, owner TEXT NOT NULL, card TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, creator_fingerprint TEXT, sponsored_at INTEGER)',
  );
  old
    .prepare('INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('old', 'owner', JSON.stringify(normalizeCard(page([normal()]))), 7, 123, 'creator', 456);
  const before = { ...old.prepare('SELECT * FROM cards').get() };
  old.close();
  let db: Database | null | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      db = await openDatabase({ dbPath, databaseUrl: '' });
      assert.deepEqual(
        { ...(await db.execute('SELECT * FROM cards')).rows[0] },
        {
          ...before,
          verified_at: null,
          custom_badges: null,
        },
      );
      const columns = (await db.execute('PRAGMA table_info(cards)')).rows;
      for (const [name, type] of [
        ['verified_at', 'INTEGER'],
        ['custom_badges', 'TEXT'],
      ]) {
        // The migration adds each named column before the database opens.
        const column = columns.find((item) => item.name === name) as Record<string, unknown>;
        assert.equal(column.type, type);
        assert.equal(column.notnull, 0);
      }
      await db.close();
      db = null;
    }
  } finally {
    await db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('local admin custom and verified badges stay separate, ordered and independently revocable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-header-badges-'));
  const dbPath = join(directory, 'cards.sqlite');
  const { server, close } = createApp({ dbPath, databaseUrl: '', origin: 'https://linkbed.me' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + listeningPort(server);
  let db: DatabaseSync | undefined;
  const sessionToken = 'a'.repeat(64);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const request = (
    path: string,
    method = 'GET',
    data?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: path.startsWith('/api/admin/') ? base : 'https://linkbed.me',
        cookie: 'lembed_session=' + sessionToken,
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const row = (slug = 'test') => ({
    // Every row lookup runs after the database has been opened.
    ...(db as DatabaseSync).prepare('SELECT * FROM cards WHERE slug = ?').get(slug),
  });
  const custom = [
    { name: 'custom <badge> & "quote"', image: 'https://example.com/imageone.png' },
    { name: 'second', image: 'https://example.com/imagetwo.png' },
  ];
  try {
    assert.equal((await request('/healthz')).status, 200);
    db = new DatabaseSync(dbPath);
    const owner = hash('header badge account');
    db.prepare('INSERT INTO accounts (token_hash, created_at) VALUES (?, ?)').run(owner, 100);
    db.prepare('INSERT INTO sessions (hash, owner, expires_at) VALUES (?, ?, ?)').run(
      hash(sessionToken),
      owner,
      Date.now() + 86400000,
    );
    for (const slug of ['test', 'untouched']) {
      const response = await request('/api/cards', 'POST', {
        ...page([normal()]),
        slug,
        customBadges: custom,
        custom_badges: JSON.stringify(custom),
        verified_at: 1,
        sponsored_at: 1,
      });
      assert.equal(response.status, 201);
      for (const column of ['custom_badges', 'verified_at', 'sponsored_at'])
        assert.equal(row(slug)[column], null);
    }
    const before = row();
    const untouched = row('untouched');
    const accounts = db.prepare('SELECT * FROM accounts').all();
    const sessions = db.prepare('SELECT * FROM sessions').all();
    const embed = await (await request('/api/embeds/test')).text();
    for (const [method, route, data] of [
      ['PUT', 'badges', { badges: custom }],
      ['POST', 'verify', {}],
      ['DELETE', 'verify', undefined],
    ] satisfies [string, string, unknown][]) {
      const path = '/api/admin/cards/test/' + route;
      assert.equal(
        (await request(path, method, data, { 'x-forwarded-for': '127.0.0.1' })).status,
        404,
      );
      assert.equal((await request(path, method, data, { origin: 'https://evil.com' })).status, 403);
      assert.equal(
        (await request(path, method, data, { 'sec-fetch-site': 'cross-site' })).status,
        403,
      );
    }
    assert.deepEqual(row(), before);
    assert.equal(
      (await request('/api/admin/cards/missing/badges', 'PUT', { badges: custom })).status,
      404,
    );
    assert.equal((await request('/api/admin/cards/missing/verify', 'POST', {})).status, 404);
    const grant = await request('/api/admin/cards/test/badges', 'PUT', { badges: custom });
    assert.equal(grant.status, 200);
    assert.deepEqual(await grant.json(), { customBadges: custom });
    assert.deepEqual(row(), { ...before, custom_badges: JSON.stringify(custom) });
    const verified = await request('/api/admin/cards/test/verify', 'POST', {});
    assert.equal(verified.status, 200);
    const { verified_at }: { verified_at: number } = await verified.json();
    assert.ok(Number.isSafeInteger(verified_at) && verified_at > 0);
    assert.deepEqual(row(), { ...before, custom_badges: JSON.stringify(custom), verified_at });
    const repeatedVerification: { verified_at: unknown } = await (
      await request('/api/admin/cards/test/verify', 'POST', {})
    ).json();
    assert.equal(repeatedVerification.verified_at, verified_at);
    const sponsor = await request('/api/admin/cards/test/sponsor', 'POST', {});
    assert.equal(sponsor.status, 200);
    const { sponsored_at }: { sponsored_at: unknown } = await sponsor.json();
    assert.deepEqual(row(), {
      ...before,
      custom_badges: JSON.stringify(custom),
      verified_at,
      sponsored_at,
    });
    const adminCards: AdminBadgeList = await (await request('/api/admin/cards')).json();
    // The admin list contains the test card created above.
    const listed = adminCards.items.find(
      (item) => item.slug === 'test',
    ) as AdminBadgeList['items'][number];
    assert.deepEqual(listed.customBadges, custom);
    assert.equal(listed.verified_at, verified_at);
    assert.equal('custom_badges' in listed, false);
    const ownerList: OwnerBadgeRow[] = await (await request('/api/cards')).json();
    // Both cards were created by this owner's session.
    const ownerCard = ownerList.find((item) => item.slug === 'test') as OwnerBadgeRow;
    assert.deepEqual(ownerCard.badges, [
      { name: 'verified', icon: 'badge-check' },
      { name: 'sponsor', icon: 'heart' },
      ...custom,
    ]);
    assert.deepEqual(
      // The other card was created by the same session.
      (ownerList.find((item) => item.slug === 'untouched') as OwnerBadgeRow).badges,
      [],
    );
    assert.equal('badges' in importCardJson(JSON.stringify(ownerCard)), false);
    const html = await (await request('/test')).text();
    // The page's granted badges emit the badges container.
    const header = (
      html.match(/<div class="page-badges"[^>]*>(.+?)<\/div>/s) as RegExpMatchArray
    )[1];
    assert.ok(header.indexOf('>verified<') < header.indexOf('>sponsor<'));
    assert.ok(header.indexOf('>sponsor<') < header.indexOf('custom &lt;badge&gt;'));
    assert.ok(header.indexOf('imageone.png') < header.indexOf('imagetwo.png'));
    assert.ok(!html.includes('<badge>'));
    assert.equal(await (await request('/api/embeds/test')).text(), embed);
    const saved: Page = await (await request('/api/cards/test')).json();
    for (const field of ['custom_badges', 'customBadges', 'verified_at', 'sponsored_at', 'badges'])
      assert.equal(field in saved, false);
    assert.ok(!messageJson(saved).includes('imageone.png'));
    // Inspect the wire object for a field the import type deliberately omits.
    assert.ok(!(importCardJson(JSON.stringify(saved)) as { customBadges?: unknown }).customBadges);
    for (const corrupt of [
      '{',
      '{}',
      JSON.stringify([{ name: 'bad', image: 'http://example.com/no.png' }]),
      JSON.stringify([{ name: 'bad', image: 'https://127.0.0.1/no.png' }]),
    ]) {
      db.prepare('UPDATE cards SET custom_badges = ? WHERE slug = ?').run(corrupt, 'test');
      const adminCards: AdminBadgeList = await (await request('/api/admin/cards')).json();
      // The malformed badge column does not delete the test card.
      const listed = adminCards.items.find(
        (item) => item.slug === 'test',
      ) as AdminBadgeList['items'][number];
      assert.deepEqual(listed.customBadges, []);
      assert.doesNotMatch(await (await request('/test')).text(), /no\.png/);
    }
    db.prepare('UPDATE cards SET custom_badges = ? WHERE slug = ?').run(
      JSON.stringify(custom),
      'test',
    );
    const current = row();
    for (const data of [
      {},
      { badges: custom, verified_at: 1 },
      { badges: {} },
      { badges: Array(MAX_CUSTOM_BADGES + 1).fill(custom[0]) },
      ...[
        'http://example.com/x',
        'https://127.0.0.1/x',
        'https://10.0.0.1/x',
        'https://169.254.169.254/x',
        'https://0x7f000001/x',
        'https://2130706433/x',
        'https://localhost/x',
        'https://host.internal/x',
      ].map((image) => ({ badges: [{ name: 'bad', image }] })),
    ])
      assert.equal((await request('/api/admin/cards/test/badges', 'PUT', data)).status, 400);
    assert.deepEqual(row(), current);
    const full = Array(MAX_CUSTOM_BADGES).fill({
      name: 'x'.repeat(80),
      image: 'https://example.com/' + 'x'.repeat(2028),
    });
    assert.ok(Buffer.byteLength(JSON.stringify({ badges: full })) > 16384);
    assert.equal(
      (await request('/api/admin/cards/test/badges', 'PUT', { badges: full })).status,
      200,
    );
    // The preceding successful grant stores the badge array as text.
    const storedBadges: unknown[] = JSON.parse(row().custom_badges as string);
    assert.equal(storedBadges.length, MAX_CUSTOM_BADGES);
    assert.equal(
      (await request('/api/admin/cards/test/badges', 'PUT', { badges: custom })).status,
      200,
    );
    assert.equal(
      (await request('/api/cards/test', 'PUT', page([normal('content edit')], { url: '' }))).status,
      200,
    );
    assert.equal(
      row().verified_at,
      verified_at,
      'content and equivalent URL edits keep verification',
    );
    assert.equal(
      (await request('/api/cards/test', 'PUT', { ...page([normal()]), slug: 'untouched' })).status,
      409,
    );
    assert.equal(row().verified_at, verified_at, 'failed rename keeps verification');
    assert.equal(
      (
        await request('/api/cards/test', 'PUT', {
          ...page([normal('edited')]),
          slug: 'renamed',
          customBadges: [],
          custom_badges: null,
          verified_at: null,
          sponsored_at: null,
        })
      ).status,
      200,
    );
    assert.equal(row('renamed').verified_at, null, 'new custom link clears verification');
    assert.equal(row('renamed').sponsored_at, sponsored_at);
    assert.equal(row('renamed').custom_badges, JSON.stringify(custom));
    assert.equal((await request('/api/admin/cards/renamed/verify', 'POST', {})).status, 200);
    assert.ok(row('renamed').verified_at);
    assert.equal(
      (
        await request('/api/cards/renamed', 'PUT', {
          ...page([normal('edited')]),
          url: 'https://example.com/',
        })
      ).status,
      200,
    );
    assert.equal(row('renamed').verified_at, null, 'new destination clears verification');
    assert.equal(row('renamed').sponsored_at, sponsored_at);
    assert.equal(row('renamed').custom_badges, JSON.stringify(custom));
    const updatedCards: OwnerBadgeRow[] = await (await request('/api/cards')).json();
    // The renamed card still belongs to the test session.
    const badges = (updatedCards.find((item) => item.slug === 'renamed') as OwnerBadgeRow).badges;
    assert.deepEqual(badges, [{ name: 'sponsor', icon: 'heart' }, ...custom]);
    assert.equal((await request('/api/admin/cards/renamed/verify', 'POST', {})).status, 200);
    const reverified = row('renamed').verified_at;
    assert.equal(
      (
        await request(
          '/api/cards/renamed',
          'PUT',
          page([normal('more text')], { url: 'HTTPS://EXAMPLE.COM' }),
        )
      ).status,
      200,
    );
    assert.equal(row('renamed').verified_at, reverified, 'normalized URL keeps verification');
    assert.doesNotMatch(await (await request('/renamed')).text(), /class="page-badges"/);
    for (const badges of [[], null]) {
      const beforeClear = row('renamed');
      assert.deepEqual(
        await (await request('/api/admin/cards/renamed/badges', 'PUT', { badges })).json(),
        { customBadges: [] },
      );
      assert.deepEqual(row('renamed'), { ...beforeClear, custom_badges: null });
    }
    const beforeRevoke = row('renamed');
    assert.equal((await request('/api/admin/cards/renamed/verify', 'DELETE')).status, 200);
    assert.deepEqual(row('renamed'), { ...beforeRevoke, verified_at: null });
    assert.deepEqual(row('untouched'), untouched);
    assert.deepEqual(db.prepare('SELECT * FROM accounts').all(), accounts);
    assert.deepEqual(db.prepare('SELECT * FROM sessions').all(), sessions);
  } finally {
    db?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
