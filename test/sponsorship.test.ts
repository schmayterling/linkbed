import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { createApp } from '../server.ts';
import { createHandler } from '../handler.ts';
import { normalizeCard, embedJson } from '../public/model.mts';
import { importCardJson } from '../public/interchange.mts';
import { renderCard } from '../render.ts';

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

const page = {
  title: 'sponsor test',
  url: null,
  component: { type: 17, components: [{ type: 10, content: 'keep this card' }] },
};

test('sponsorship comes only from server metadata and stays out of redirects and Discord', () => {
  const card = normalizeCard({ ...page, sponsored_at: 1, sponsored: true });
  assert.equal('sponsored_at' in card, false);
  assert.equal('sponsored' in card, false);
  const url = 'https://linkbed.me/test';
  assert.doesNotMatch(renderCard(card, url), /class="page-badge"/);
  assert.match(renderCard(card, url, { sponsoredAt: 1 }), /class="page-badge"/);
  assert.doesNotMatch(
    renderCard({ ...card, url: 'https://example.com/' }, url, { sponsoredAt: 1 }),
    /class="page-badge"/,
  );
});

test('sponsor visibility is optional card data and leaves other badges and Discord unchanged', () => {
  const card = normalizeCard({ ...page, sponsor_hidden: true, sponsored: true });
  assert.equal(card.sponsor_hidden, true);
  assert.equal('sponsored' in card, false);
  assert.equal(importCardJson(JSON.stringify(card)).sponsor_hidden, true);
  assert.equal(embedJson(card), embedJson(normalizeCard(page)));
  const html = renderCard(card, 'https://linkbed.me/test', {
    sponsoredAt: 1,
    verifiedAt: 1,
    customBadges: [{ name: 'funky', image: 'https://example.com/funky.gif' }],
  });
  assert.doesNotMatch(html, />sponsor</);
  assert.match(html, />verified</);
  assert.match(html, />funky</);
  for (const sponsor_hidden of ['true', 1, null])
    assert.throws(() => normalizeCard({ ...page, sponsor_hidden }), { status: 400 });
});

test('sponsor admin route is unavailable without local admin access before connecting to db', async () => {
  // Denying this route only requires the response methods used to send the rejection.
  const handler = createHandler({ databaseUrl: 'https://unused.invalid' }) as AdminRejectionHandler;
  try {
    for (const method of ['POST', 'DELETE']) {
      let status: number | undefined, output: string | undefined;
      await handler(
        // The denied route reads only these request fields.
        {
          url: '/api/admin/cards/test/sponsor',
          method,
          headers: { host: 'localhost' },
          socket: { remoteAddress: '127.0.0.1' },
        } as Parameters<typeof handler>[0],
        {
          setHeader() {},
          writeHead(value: number) {
            status = value;
          },
          end(value: string) {
            output = value;
          },
        },
      );
      assert.equal(status, 404);
      // The denied route writes the JSON error before the handler resolves.
      const body: { error: unknown } = JSON.parse(output as string);
      assert.equal(body.error, 'page not found.');
    }
  } finally {
    await handler.close();
  }
});

test('admin sponsorship changes only its column, survives owner edits and renames, and is revocable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-sponsor-'));
  const dbPath = join(directory, 'cards.sqlite');
  const { server, close } = createApp({ dbPath, databaseUrl: '', origin: 'https://linkbed.me' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  // The TCP listener has emitted 'listening', so address() returns AddressInfo.
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  let db: DatabaseSync | undefined;
  const sessionToken = 'a'.repeat(64);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const owner = hash('existing account');
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
  const row = (slug: string) => ({
    // All row lookups happen after the local database is opened.
    ...(db as DatabaseSync).prepare('SELECT * FROM cards WHERE slug = ?').get(slug),
  });
  try {
    assert.equal((await request('/healthz')).status, 200);
    db = new DatabaseSync(dbPath);
    // The migration creates this column before the health check completes.
    const column = db
      .prepare('PRAGMA table_info(cards)')
      .all()
      .find((item) => item.name === 'sponsored_at') as Record<string, SQLOutputValue>;
    assert.equal(column.type, 'INTEGER');
    assert.equal(column.notnull, 0);
    db.prepare('INSERT INTO accounts (token_hash, created_at) VALUES (?, ?)').run(owner, 100);
    db.prepare('INSERT INTO sessions (hash, owner, expires_at) VALUES (?, ?, ?)').run(
      hash(sessionToken),
      owner,
      Date.now() + 86400000,
    );
    for (const slug of ['test', 'untouched'])
      db.prepare(
        'INSERT INTO cards (slug, owner, card, revision, updated_at, creator_fingerprint) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(slug, owner, JSON.stringify(normalizeCard(page)), 7, 100, hash('existing browser'));
    const before = row('test');
    const untouched = row('untouched');
    const accounts = db.prepare('SELECT * FROM accounts').all();
    const sessions = db.prepare('SELECT * FROM sessions').all();
    const embed = await (await request('/api/embeds/test')).text();
    assert.doesNotMatch(await (await request('/test')).text(), /class="page-badge"/);
    assert.equal(
      (
        await request(
          '/api/admin/cards/test/sponsor',
          'POST',
          {},
          { 'x-forwarded-for': '127.0.0.1' },
        )
      ).status,
      404,
    );
    assert.equal(
      (await request('/api/admin/cards/test/sponsor', 'POST', {}, { origin: 'https://evil.com' }))
        .status,
      403,
    );
    assert.equal(row('test').sponsored_at, null);
    assert.equal((await request('/api/admin/cards/missing/sponsor', 'POST', {})).status, 404);

    const grant = await request('/api/admin/cards/test/sponsor', 'POST', {});
    assert.equal(grant.status, 200);
    const { sponsored_at }: { sponsored_at: number } = await grant.json();
    assert.ok(Number.isSafeInteger(sponsored_at) && sponsored_at > 0);
    assert.deepEqual(row('test'), { ...before, sponsored_at });
    assert.deepEqual(row('untouched'), untouched);
    assert.deepEqual(db.prepare('SELECT * FROM accounts').all(), accounts);
    assert.deepEqual(db.prepare('SELECT * FROM sessions').all(), sessions);
    const repeatedGrant: { sponsored_at: unknown } = await (
      await request('/api/admin/cards/test/sponsor', 'POST', {})
    ).json();
    assert.equal(repeatedGrant.sponsored_at, sponsored_at);
    const adminCards: { items: { slug: unknown; sponsored_at: unknown }[] } = await (
      await request('/api/admin/cards')
    ).json();
    assert.equal(
      // The admin list includes the test card inserted above.
      (adminCards.items.find((item) => item.slug === 'test') as (typeof adminCards.items)[number])
        .sponsored_at,
      sponsored_at,
    );
    assert.match(await (await request('/test')).text(), /class="page-badge"/);
    assert.equal(await (await request('/api/embeds/test')).text(), embed);
    const grantedCard: { sponsored: unknown } = await (await request('/api/cards/test')).json();
    assert.equal(grantedCard.sponsored, true);
    assert.equal(
      (await request('/api/cards/test', 'PUT', { ...page, sponsor_hidden: true })).status,
      200,
    );
    assert.equal(row('test').sponsored_at, sponsored_at);
    assert.doesNotMatch(await (await request('/test')).text(), /class="page-badge"/);
    const hidden: { sponsor_hidden?: unknown; sponsored: unknown } = await (
      await request('/api/cards/test')
    ).json();
    assert.equal(hidden.sponsor_hidden, true);
    assert.equal(hidden.sponsored, true);
    const ownerCards: { slug: unknown; badges: unknown; sponsored: unknown }[] = await (
      await request('/api/cards')
    ).json();
    // The owner list includes the card seeded for this session.
    const listed = ownerCards.find((card) => card.slug === 'test') as (typeof ownerCards)[number];
    assert.deepEqual(listed.badges, [{ name: 'sponsor', icon: 'heart' }]);
    assert.equal(listed.sponsored, true);
    assert.equal(await (await request('/api/embeds/test')).text(), embed);
    assert.equal(
      (await request('/api/cards/test', 'PUT', { ...page, sponsor_hidden: false })).status,
      200,
    );
    assert.match(await (await request('/test')).text(), /class="page-badge"/);
    assert.equal(row('test').sponsored_at, sponsored_at);

    assert.equal(
      (
        await request('/api/cards', 'POST', {
          ...page,
          slug: 'forged',
          sponsored_at: 1,
          sponsored: true,
        })
      ).status,
      201,
    );
    assert.equal(row('forged').sponsored_at, null);
    assert.equal(
      (
        await request('/api/cards/test', 'PUT', {
          ...page,
          slug: 'renamed',
          title: 'edited',
          sponsored_at: null,
        })
      ).status,
      200,
    );
    assert.equal(row('renamed').sponsored_at, sponsored_at);
    assert.equal(row('renamed').owner, owner);
    // The card column is non-null text and the seeded row was renamed above.
    const renamed: Record<string, unknown> = JSON.parse(row('renamed').card as string);
    assert.equal('sponsored_at' in renamed, false);
    assert.match(await (await request('/renamed')).text(), /class="page-badge"/);

    assert.equal(
      (await request('/api/cards/renamed', 'PUT', { ...page, url: 'https://example.com/' })).status,
      200,
    );
    assert.equal(row('renamed').sponsored_at, sponsored_at);
    assert.doesNotMatch(await (await request('/renamed')).text(), /class="page-badge"/);
    const beforeRevoke = row('renamed');
    assert.equal((await request('/api/admin/cards/renamed/sponsor', 'DELETE')).status, 200);
    assert.deepEqual(row('renamed'), { ...beforeRevoke, sponsored_at: null });
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
