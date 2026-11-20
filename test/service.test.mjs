import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCard, embedJson, payloadBytes } from '../public/model.mjs';
import { isPublicAddress, resolvePublicUrl, publicUrl, metadataFromHtml } from '../metadata.mjs';
import { createApp } from '../server.mjs';

const sessionCookie = (response) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith('lembed_session='))
    .split(';')[0];

const card = {
  title: 'hello',
  description: 'a launch',
  url: 'https://example.com/',
  color: '#5865f2',
  buttons: [{ label: 'visit', url: 'https://example.com/' }],
  images: [],
};

test('payload uses one container, link buttons, escaped script text and byte limit', () => {
  const value = normalizeCard({
    ...card,
    description: '</script><script>alert("x")</script>',
    images: ['https://example.com/a.png'],
  });
  const text = embedJson(value);
  const embed = JSON.parse(text).component;
  assert.equal(embed.type, 17);
  assert.equal(embed.components[1].type, 12);
  assert.equal(embed.components[3].components[0].style, 5);
  assert.ok(!text.includes('</script>'));
  assert.equal(payloadBytes(value), Buffer.byteLength(text));
  assert.throws(() => normalizeCard({ ...card, description: '界'.repeat(1100) }), /3,000-byte/);
  assert.throws(() => normalizeCard({ ...card, buttons: Array(6).fill(card.buttons[0]) }), /five/);
  assert.throws(
    () => normalizeCard({ ...card, images: Array(11).fill('https://example.com/a.png') }),
    /ten/,
  );
  assert.throws(() => normalizeCard({ ...card, url: 'javascript:alert(1)' }), /https/);
  assert.throws(() => normalizeCard({ ...card, color: ['#abcdef'] }), /color/);
  assert.throws(
    () =>
      normalizeCard({
        ...card,
        buttons: [{ label: 'visit', url: 'https://example.com/' + '界'.repeat(60) }],
      }),
    /encoding/,
  );
});

test('homepage follows the saved linkbed card without rebuilding and survives a missing card', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-home-test-'));
  const dbPath = join(directory, 'cards.sqlite');
  const { server, close } = createApp({
    dbPath,
    databaseUrl: '',
    origin: 'https://cards.example.com',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const payload = (html) =>
    JSON.parse(
      html.match(
        /<script id="discord:component-embed" type="application\/json">(.+?)<\/script>/s,
      )[1],
    );
  let inspect;
  try {
    const empty = await fetch(base);
    assert.equal(empty.status, 200);
    assert.ok((await empty.text()).includes('id="card-form"'));
    const { DatabaseSync } = await import('node:sqlite');
    inspect = new DatabaseSync(dbPath);
    const value = normalizeCard({
      ...card,
      title: 'latest <title>',
      description: 'copy " & </script>',
      component: { type: 17, components: [{ type: 10, content: 'latest </script> $&' }] },
    });
    inspect
      .prepare('INSERT INTO cards (slug, owner, card, revision, updated_at) VALUES (?, ?, ?, 1, ?)')
      .run('linkbed', 'test', JSON.stringify(value), Date.now());
    const response = await fetch(base);
    const html = await response.text();
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('vary'), 'Cookie');
    assert.deepEqual(payload(html), JSON.parse(embedJson(value)));
    inspect
      .prepare('INSERT INTO cards (slug, owner, card, revision, updated_at) VALUES (?, ?, ?, 1, ?)')
      .run('may', 'test', JSON.stringify(value), Date.now());
    const starterHtml = await (await fetch(base)).text();
    const starter = JSON.parse(
      starterHtml.match(/<script id="starter-card" type="application\/json">(.+?)<\/script>/s)[1],
    );
    assert.deepEqual(starter, value);
    assert.ok(!starterHtml.includes('<script>alert'));
    const publicJson = await fetch(base + '/api/embeds/may');
    assert.equal(publicJson.status, 200);
    assert.equal(publicJson.headers.get('set-cookie'), null);
    assert.equal(publicJson.headers.get('cache-control'), 'no-store');
    assert.match(publicJson.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await publicJson.json(), JSON.parse(embedJson(value)));
    const publicHead = await fetch(base + '/api/embeds/may', { method: 'HEAD' });
    assert.equal(publicHead.status, 200);
    assert.equal(await publicHead.text(), '');
    assert.equal((await fetch(base + '/api/embeds/missing')).status, 404);
    assert.match(html, /property="og:title" content="latest &lt;title&gt;"/);
    assert.match(html, /property="og:url" content="https:\/\/cards.example.com\/"/);
    assert.match(html, /id="slug-prefix">cards.example.com\//);
    assert.match(html, /copy &quot; &amp; &lt;\/script&gt;/);
    assert.ok(!html.includes('content="copy "'));
    assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
    assert.equal(await (await fetch(base, { method: 'HEAD' })).text(), '');
    const updated = {
      ...value,
      description: 'updated copy',
      component: { type: 17, components: [{ type: 10, content: 'updated card' }] },
    };
    inspect
      .prepare('UPDATE cards SET card = ? WHERE slug = ?')
      .run(JSON.stringify(updated), 'linkbed');
    assert.deepEqual(
      payload(await (await fetch(base + '/api/index?home=1')).text()),
      JSON.parse(embedJson(updated)),
    );
    inspect.prepare('UPDATE cards SET card = ? WHERE slug = ?').run(JSON.stringify(updated), 'may');
    assert.deepEqual(
      await (await fetch(base + '/api/index?route=embeds/may')).json(),
      JSON.parse(embedJson(updated)),
    );
    const changedStarter = await (await fetch(base)).text();
    assert.deepEqual(
      JSON.parse(
        changedStarter.match(
          /<script id="starter-card" type="application\/json">(.+?)<\/script>/s,
        )[1],
      ),
      updated,
    );
    inspect
      .prepare('INSERT INTO banned_slugs (slug, banned_at) VALUES (?, ?)')
      .run('may', Date.now());
    assert.equal((await fetch(base + '/api/embeds/may')).status, 404);
    assert.ok(!(await (await fetch(base)).text()).includes('id="starter-card"'));
    inspect.prepare('DELETE FROM cards WHERE slug = ?').run('may');
    assert.equal((await fetch(base + '/api/embeds/may')).status, 404);
    inspect
      .prepare('INSERT INTO banned_slugs (slug, banned_at) VALUES (?, ?)')
      .run('linkbed', Date.now());
    assert.ok(!(await (await fetch(base)).text()).includes('discord:component-embed'));
    inspect.prepare('DELETE FROM cards WHERE slug = ?').run('linkbed');
    assert.equal((await fetch(base)).status, 200);
  } finally {
    inspect?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('URL import rejects private and disguised addresses, validates every DNS result', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  for (const url of [
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://localhost/',
    'https://me:secret@example.com/',
    'https://example.com:8443/',
  ])
    assert.throws(() => publicUrl(url));
  await assert.rejects(
    resolvePublicUrl('https://example.com', async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]),
    /private/,
  );
  const resolved = await resolvePublicUrl('https://example.com', async () => [
    { address: '1.1.1.1', family: 4 },
  ]);
  assert.equal(resolved.record.address, '1.1.1.1');
});

test('metadata import parses entities, relative images and fallbacks without executing html', () => {
  const result = metadataFromHtml(
    '<title>fallback</title><meta property="og:title" content="fish &amp; chips"><meta name="description" content="hello"><meta property="og:image" content="/image.png"><script>throw 1</script>',
    'https://example.com/page',
  );
  assert.equal(result.title, 'fish & chips');
  assert.equal(result.description, 'hello');
  assert.deepEqual(result.images, ['https://example.com/image.png']);
  assert.deepEqual(
    metadataFromHtml(
      '<meta property="og:image" content="http://127.0.0.1/x">',
      'https://example.com',
    ).images,
    [],
  );
});

test('token accounts, ownership, logout, expiry, SSR and restart persistence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lembed-test-'));
  const dbPath = join(directory, 'cards.sqlite');
  let server, close, base;
  const start = async () => {
    ({ server, close } = createApp({ dbPath }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
  };
  const request = (path, method = 'GET', data, owner = '', origin = 'http://localhost:3000') =>
    fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', origin, cookie: owner },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  await start();
  try {
    assert.deepEqual(await request('/api/cards').then((r) => r.json()), []);
    assert.equal(
      (await request('/api/signup', 'POST', {}, '', 'https://evil.example')).status,
      403,
    );
    const signup = await request('/api/signup', 'POST', {});
    assert.equal(signup.status, 201);
    const { token } = await signup.json();
    assert.match(token, /^lembed_[A-Za-z0-9_-]{43}$/);
    let session = sessionCookie(signup);
    assert.ok(signup.headers.get('set-cookie').includes('HttpOnly'));
    assert.ok(signup.headers.get('set-cookie').includes('SameSite=Strict'));
    assert.ok(!session.includes(token));
    const { DatabaseSync } = await import('node:sqlite');
    const inspect = new DatabaseSync(dbPath);
    const account = inspect.prepare('SELECT token_hash FROM accounts').get();
    assert.equal(account.token_hash.length, 64);
    assert.notEqual(account.token_hash, token);
    assert.ok(
      !JSON.stringify(inspect.prepare('SELECT * FROM sessions').all()).includes(
        session.split('=')[1],
      ),
    );
    inspect.close();

    assert.equal((await request('/api/cards', 'POST', null, session)).status, 400);
    assert.equal(
      (await request('/api/cards', 'POST', { ...card, slug: '../escape' }, session)).status,
      400,
    );
    assert.equal(
      (
        await request(
          '/api/cards',
          'POST',
          { ...card, slug: 'private', url: 'https://127.0.0.1/' },
          session,
        )
      ).status,
      400,
    );
    const created = await request(
      '/api/cards',
      'POST',
      { ...card, title: '<script>alert(1)</script>', slug: 'launch' },
      session,
    );
    assert.equal(created.status, 201);
    const published = await created.json();
    assert.equal(published.revision, 1);
    assert.equal(published.url, 'http://localhost:3000/launch');
    assert.equal((await request('/launch')).status, 200);
    assert.equal(
      (await request('/api/cards', 'POST', { ...card, slug: 'healthz' }, session)).status,
      400,
    );
    assert.equal(
      (await request('/api/cards', 'POST', { ...card, slug: 'launch' }, session)).status,
      409,
    );
    const page = await fetch(base + '/p/launch', { headers: { 'user-agent': 'Discordbot/2.0' } });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /property="og:title"/);
    assert.match(html, /script id="discord:component-embed"/);
    assert.match(html, /src="\/redirect.mjs"/);
    assert.match(html, /data-redirect href="https:\/\/example.com\/"/);
    assert.equal(page.headers.get('location'), null);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    const payload = JSON.parse(
      html.match(
        /<script id="discord:component-embed" type="application\/json">(.+?)<\/script>/s,
      )[1],
    );
    assert.equal(payload.component.type, 17);
    assert.equal((await request('/api/index?card=launch')).status, 200);
    for (const asset of [
      '/components.mjs',
      '/icons.mjs',
      '/code-editor.mjs',
      '/vendor/markdown-it.mjs',
      '/vendor/codemirror.mjs',
      '/vendor/coloris.mjs',
      '/emoji-picker.mjs',
      '/vendor/sortable.mjs',
      '/vendor/emoji-picker.mjs',
      '/vendor/emoji-database.mjs',
    ]) {
      const assetResponse = await request(asset);
      assert.equal(assetResponse.status, 200);
      assert.match(assetResponse.headers.get('content-type'), /javascript/);
    }
    const fullCard = normalizeCard({
      ...card,
      color: null,
      component: {
        type: 17,
        spoiler: true,
        accent_color: null,
        components: [
          {
            type: 9,
            components: [{ type: 10, content: '## full card' }],
            accessory: {
              type: 11,
              media: { url: 'http://example.com/thumb.png' },
              description: 'thumbnail',
            },
          },
          { type: 12, items: [{ media: { url: 'https://example.com/clip.mp4' }, spoiler: true }] },
          { type: 14, divider: false, spacing: 2 },
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 5,
                url: 'http://example.com/side',
                emoji: { name: '🔥', id: null },
                disabled: true,
              },
            ],
          },
        ],
      },
    });
    const fullCreated = await request(
      '/api/cards',
      'POST',
      { ...fullCard, slug: 'full-card' },
      session,
    );
    assert.equal(fullCreated.status, 201);
    const fullStored = await request('/api/cards/full-card', 'GET', undefined, session).then(
      (response) => response.json(),
    );
    assert.deepEqual(fullStored.component, fullCard.component);
    const fullHtml = await request('/full-card').then((response) => response.text());
    const fullPayload = JSON.parse(
      fullHtml.match(
        /<script id="discord:component-embed" type="application\/json">(.+?)<\/script>/s,
      )[1],
    );
    assert.deepEqual(fullPayload.component, fullCard.component);
    assert.ok(!fullHtml.includes('og:image" content="https://example.com/clip.mp4'));
    assert.ok(!fullHtml.includes('theme-color" content="null'));
    const privateButton = structuredClone(fullCard);
    privateButton.component.components[3].components[0].url = 'http://127.0.0.1/';
    assert.equal(
      (await request('/api/cards', 'POST', { ...privateButton, slug: 'private-button' }, session))
        .status,
      400,
    );
    assert.equal((await request('/api/cards/full-card', 'DELETE', undefined, session)).status, 200);

    assert.equal(
      (await request('/api/cards', 'POST', { ...card, slug: 'custom-path' }, session)).status,
      201,
    );
    const moved = await request(
      '/api/cards/custom-path',
      'PUT',
      { ...card, slug: 'another-path' },
      session,
    );
    assert.equal(moved.status, 200);
    const movedCard = await moved.json();
    assert.equal(movedCard.slug, 'another-path');
    assert.equal(movedCard.url, 'http://localhost:3000/another-path');
    assert.equal(movedCard.revision, 2);
    assert.equal((await request('/custom-path')).status, 404);
    assert.equal((await request('/another-path')).status, 200);
    assert.equal(
      (await request('/api/cards/another-path', 'PUT', { ...card, slug: 'launch' }, session))
        .status,
      409,
    );
    assert.equal((await request('/api/cards/another-path', 'GET', undefined, session)).status, 200);
    assert.equal(
      (await request('/api/cards/another-path', 'PUT', { ...card, slug: 'healthz' }, session))
        .status,
      400,
    );
    assert.equal(
      (await request('/api/cards/another-path', 'DELETE', undefined, session)).status,
      200,
    );

    const otherSignup = await request('/api/signup', 'POST', {});
    const otherSession = sessionCookie(otherSignup);
    assert.equal((await request('/api/cards/launch', 'PUT', card, otherSession)).status, 404);
    assert.equal(
      (await request('/api/cards/launch', 'PUT', { ...card, slug: 'stolen' }, otherSession)).status,
      404,
    );
    assert.equal((await request('/stolen')).status, 404);
    assert.equal(
      (await request('/api/cards/launch', 'DELETE', undefined, otherSession)).status,
      404,
    );
    const updated = await request(
      '/api/cards/launch',
      'PUT',
      { ...card, title: 'updated' },
      session,
    );
    assert.equal((await updated.json()).revision, 2);

    await request('/api/logout', 'POST', {}, session);
    assert.equal(
      (await request('/api/session', 'GET', undefined, session).then((r) => r.json()))
        .authenticated,
      false,
    );
    assert.deepEqual(
      await request('/api/cards', 'GET', undefined, session).then((r) => r.json()),
      [],
    );
    assert.equal((await request('/api/login', 'POST', { token: 'wrong' })).status, 401);
    const login = await request('/api/login', 'POST', { token });
    assert.equal(login.status, 200);
    session = sessionCookie(login);
    assert.equal((await login.json()).token, undefined);
    assert.equal(
      (await request('/api/cards', 'GET', undefined, session).then((r) => r.json()))[0].title,
      'updated',
    );

    await stop();
    await start();
    const restored = await request('/api/cards/launch', 'GET', undefined, session);
    assert.equal((await restored.json()).title, 'updated');

    const expiry = new DatabaseSync(dbPath);
    expiry.prepare('UPDATE sessions SET expires_at = 0').run();
    expiry.close();
    assert.deepEqual(
      await request('/api/cards', 'GET', undefined, session).then((r) => r.json()),
      [],
    );
    const relogin = await request('/api/login', 'POST', { token });
    session = sessionCookie(relogin);
    assert.equal((await request('/api/cards/launch', 'DELETE', undefined, session)).status, 200);
    assert.equal((await fetch(base + '/p/launch')).status, 404);
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('guest cards stay live without a token and transfer ownership on sign-in', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-guest-'));
  const dbPath = join(directory, 'cards.sqlite');
  const { server, close } = createApp({ dbPath, origin: 'https://linkbed.ryana.dev' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', data, cookie = '', origin = 'https://linkbed.ryana.dev') =>
    fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', origin, cookie },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const sessionCookie = (response) =>
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith('lembed_session='))
      .split(';')[0];
  try {
    assert.deepEqual(await request('/api/cards').then((r) => r.json()), []);
    assert.equal((await request('/api/guest', 'POST', {}, '', 'https://evil.example')).status, 403);

    const created = await request('/api/guest', 'POST', {});
    assert.equal(created.status, 201);
    const guest = await created.json();
    assert.equal(guest.authenticated, false);
    assert.equal(guest.guest, true);
    assert.equal(guest.expiresAt, undefined);
    const firstCookie = sessionCookie(created);
    assert.match(created.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\//);
    assert.match(created.headers.get('set-cookie'), /; Secure/);
    assert.ok(!JSON.stringify(guest).includes(firstCookie.split('=')[1]));
    assert.deepEqual(
      await request('/api/guest', 'POST', {}, firstCookie).then((r) => r.json()),
      guest,
    );

    const { DatabaseSync } = await import('node:sqlite');
    const inspect = new DatabaseSync(dbPath);
    assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 0);
    assert.ok(
      !JSON.stringify(inspect.prepare('SELECT * FROM sessions').all()).includes(
        firstCookie.split('=')[1],
      ),
    );
    inspect.close();
    const firstCard = await request(
      '/api/cards',
      'POST',
      { ...card, slug: 'guest-card', expiresAt: 0 },
      firstCookie,
    );
    assert.equal(firstCard.status, 201);
    assert.equal((await firstCard.json()).expiresAt, undefined);
    assert.equal((await request('/guest-card')).headers.get('cache-control'), 'public, max-age=60');
    assert.equal(
      (await request('/api/cards', 'POST', { ...card, slug: 'guest-card-two' }, firstCookie))
        .status,
      201,
    );
    assert.equal(
      (await request('/api/cards/guest-card', 'PUT', { ...card, title: 'guest edit' }, firstCookie))
        .status,
      200,
    );
    const other = await request('/api/guest', 'POST', {});
    const otherCookie = sessionCookie(other);
    assert.deepEqual(
      await request('/api/cards', 'GET', undefined, otherCookie).then((r) => r.json()),
      [],
    );
    assert.equal((await request('/api/cards/guest-card', 'PUT', card, otherCookie)).status, 404);
    assert.equal(
      (await request('/api/cards/guest-card', 'DELETE', undefined, otherCookie)).status,
      404,
    );

    const update = await request(
      '/api/cards/guest-card',
      'PUT',
      { ...card, expiresAt: 0 },
      firstCookie,
    );
    assert.equal(update.status, 200);
    assert.equal((await update.json()).expiresAt, undefined);
    assert.ok(!update.headers.getSetCookie().some((value) => value.startsWith('lembed_session=')));
    assert.equal(
      (await request('/api/cards/guest-card', 'GET', undefined, firstCookie).then((r) => r.json()))
        .expiresAt,
      undefined,
    );
    assert.equal(
      (await request('/api/cards', 'GET', undefined, firstCookie).then((r) => r.json())).length,
      2,
    );
    const staleLogout = await request('/api/logout', 'POST', {}, firstCookie);
    assert.equal((await staleLogout.json()).guest, true);
    assert.equal(staleLogout.headers.get('set-cookie'), null);
    assert.equal(
      (await request('/api/cards', 'GET', undefined, firstCookie).then((r) => r.json())).length,
      2,
    );

    const upgraded = await request('/api/signup', 'POST', {}, firstCookie);
    assert.equal(upgraded.status, 201);
    const { token } = await upgraded.json();
    const accountCookie = sessionCookie(upgraded);
    assert.notEqual(accountCookie, firstCookie);
    assert.equal((await request('/api/signup', 'POST', {}, accountCookie)).status, 409);
    assert.equal(
      (await request('/api/session', 'GET', undefined, accountCookie).then((r) => r.json()))
        .authenticated,
      true,
    );
    assert.equal(
      (await request('/api/cards', 'GET', undefined, accountCookie).then((r) => r.json())).length,
      2,
    );
    assert.deepEqual(
      await request('/api/cards', 'GET', undefined, firstCookie).then((r) => r.json()),
      [],
    );
    assert.equal((await request('/api/cards/guest-card', 'PUT', card, firstCookie)).status, 401);
    const recovered = await request('/api/login', 'POST', { token });
    const recoveredCards = await request(
      '/api/cards',
      'GET',
      undefined,
      sessionCookie(recovered),
    ).then((r) => r.json());
    assert.equal(recoveredCards.length, 2);
    assert.ok(recoveredCards.every((card) => card.expiresAt === undefined));

    assert.equal(
      (await request('/api/cards', 'POST', { ...card, slug: 'merged-card' }, otherCookie)).status,
      201,
    );
    const failedLogin = await request('/api/login', 'POST', { token: 'wrong' }, otherCookie);
    assert.equal(failedLogin.status, 401);
    assert.equal(
      (await request('/api/cards', 'GET', undefined, otherCookie).then((r) => r.json())).length,
      1,
    );
    const merged = await request('/api/login', 'POST', { token }, otherCookie);
    assert.equal(
      (await request('/api/cards', 'GET', undefined, sessionCookie(merged)).then((r) => r.json()))
        .length,
      3,
    );
    assert.equal(
      (await request('/api/cards/merged-card', 'DELETE', undefined, otherCookie)).status,
      401,
    );

    const freshGuest = await request('/api/guest', 'POST', {});
    const expiredCookie = sessionCookie(freshGuest);
    assert.equal(
      (await request('/api/cards', 'POST', { ...card, slug: 'permanent-card' }, expiredCookie))
        .status,
      201,
    );
    const expire = new DatabaseSync(dbPath);
    expire.prepare('UPDATE sessions SET expires_at = 0 WHERE owner LIKE ?').run('guest:%');
    expire.close();
    assert.equal(
      (await request('/api/session', 'GET', undefined, expiredCookie).then((r) => r.json())).guest,
      false,
    );
    assert.deepEqual(
      await request('/api/cards', 'GET', undefined, expiredCookie).then((r) => r.json()),
      [],
    );
    assert.equal(
      (await request('/api/cards/permanent-card', 'PUT', card, expiredCookie)).status,
      401,
    );
    assert.equal((await request('/permanent-card')).status, 200);
    assert.equal((await request('/p/permanent-card')).status, 200);
    assert.equal((await request('/permanent-card', 'HEAD')).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('regenerating a token keeps cards, revokes the old token and signs out other devices', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-regenerate-'));
  const { server, close } = createApp({ dbPath: join(directory, 'cards.sqlite') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', data, cookie = '') =>
    fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', cookie },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const cardTitles = async (cookie) =>
    (await request('/api/cards', 'GET', undefined, cookie).then((r) => r.json())).map(
      (item) => item.title,
    );
  try {
    const signup = await request('/api/signup', 'POST', {});
    const { token: oldToken } = await signup.json();
    const laptop = sessionCookie(signup);
    const phone = sessionCookie(await request('/api/login', 'POST', { token: oldToken }));
    await request('/api/cards', 'POST', { ...card, slug: 'mine', title: 'mine' }, laptop);
    const stranger = sessionCookie(await request('/api/signup', 'POST', {}));
    await request('/api/cards', 'POST', { ...card, slug: 'theirs', title: 'theirs' }, stranger);
    const guest = sessionCookie(await request('/api/guest', 'POST', {}));

    assert.equal((await request('/api/regenerate-token', 'POST', {})).status, 401);
    assert.equal((await request('/api/regenerate-token', 'POST', {}, guest)).status, 401);

    const regenerated = await request('/api/regenerate-token', 'POST', {}, laptop);
    assert.equal(regenerated.status, 201);
    const { token: newToken } = await regenerated.json();
    assert.match(newToken, /^lembed_[A-Za-z0-9_-]{43}$/);
    const current = sessionCookie(regenerated);
    assert.deepEqual(await cardTitles(current), ['mine']);
    assert.deepEqual(await cardTitles(laptop), []);
    assert.deepEqual(await cardTitles(phone), []);
    assert.deepEqual(await cardTitles(stranger), ['theirs']);
    assert.equal((await request('/api/login', 'POST', { token: oldToken })).status, 401);
    const login = await request('/api/login', 'POST', { token: newToken });
    assert.deepEqual(await cardTitles(sessionCookie(login)), ['mine']);

    const racing = await Promise.all([
      request('/api/regenerate-token', 'POST', {}, current),
      request('/api/regenerate-token', 'POST', {}, current),
    ]);
    const winners = racing.filter((response) => response.status === 201);
    assert.equal(winners.length, 1);
    assert.deepEqual(await cardTitles(sessionCookie(winners[0])), ['mine']);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('removing card expiry preserves existing cards and restores their public links', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-migrate-'));
  const dbPath = join(directory, 'cards.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(
    'CREATE TABLE cards (slug TEXT PRIMARY KEY, owner TEXT NOT NULL, card TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER)',
  );
  for (const owner of ['guest', 'account'])
    old
      .prepare('INSERT INTO cards VALUES (?, ?, ?, 1, ?, ?)')
      .run(owner, owner, JSON.stringify(card), Date.now(), owner === 'guest' ? 0 : null);
  old.close();
  const { server, close } = createApp({ dbPath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/guest')).status, 200);
    assert.equal((await fetch(base + '/account')).status, 200);
    const inspect = new DatabaseSync(dbPath);
    try {
      assert.ok(
        !inspect
          .prepare('PRAGMA table_info(cards)')
          .all()
          .some((column) => column.name === 'expires_at'),
      );
      const rows = inspect.prepare('SELECT owner, card, revision FROM cards ORDER BY owner').all();
      assert.deepEqual(
        rows.map((row) => row.owner),
        ['account', 'guest'],
      );
      assert.ok(rows.every((row) => row.card === JSON.stringify(card) && row.revision === 1));
    } finally {
      inspect.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('auth throttling persists and legacy local cards migrate on account creation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lembed-auth-'));
  const dbPath = join(directory, 'cards.sqlite');
  const { server, close } = createApp({ dbPath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'content-type': 'application/json', origin: 'http://localhost:3000' };
  try {
    await fetch(base + '/healthz');
    const { DatabaseSync } = await import('node:sqlite');
    const { createHash } = await import('node:crypto');
    const legacyToken = 'a'.repeat(64);
    const inspect = new DatabaseSync(dbPath);
    inspect
      .prepare('INSERT INTO cards (slug, owner, card, revision, updated_at) VALUES (?, ?, ?, 1, ?)')
      .run(
        'old-card',
        createHash('sha256').update(legacyToken).digest('hex'),
        JSON.stringify(card),
        Date.now(),
      );
    inspect.close();
    const signup = await fetch(base + '/api/signup', {
      method: 'POST',
      headers: { ...headers, cookie: 'lembed_owner=' + legacyToken },
      body: '{}',
    });
    const session = sessionCookie(signup);
    const cards = await fetch(base + '/api/cards', { headers: { cookie: session } }).then((r) =>
      r.json(),
    );
    assert.equal(cards[0].slug, 'old-card');
    for (let i = 0; i < 9; i++)
      assert.equal(
        (await fetch(base + '/api/login', { method: 'POST', headers, body: '{"token":"wrong"}' }))
          .status,
        401,
      );
    assert.equal(
      (await fetch(base + '/api/login', { method: 'POST', headers, body: '{"token":"wrong"}' }))
        .status,
      429,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('initial card data is private, escaped, and uses the current owner session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lembed-initial-'));
  const { server, close } = createApp({ dbPath: join(dir, 'cards.sqlite'), databaseUrl: '' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (path, method = 'GET', body, cookie = '') =>
    fetch(base + path, {
      method,
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const initial = (html) =>
    JSON.parse(
      html.split('<script id="initial-cards" type="application/json">')[1].split('</script>')[0],
    );
  try {
    const owner = sessionCookie(await request('/api/signup', 'POST', {}));
    const other = sessionCookie(await request('/api/signup', 'POST', {}));
    const title = 'private </script><img src=x onerror=alert(1)>';
    const create = await request(
      '/api/cards',
      'POST',
      {
        title,
        slug: 'private-boot',
        url: null,
        component: { type: 17, components: [{ type: 10, content: 'private boot content' }] },
      },
      owner,
    );
    assert.equal(create.status, 201);
    const response = await request('/', 'GET', undefined, owner);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('vary'), 'Cookie');
    const html = await response.text();
    const snapshot = initial(html);
    assert.equal(snapshot.authenticated, true);
    assert.equal(snapshot.cards[0].title, title);
    assert.deepEqual(
      snapshot.cards,
      await (await request('/api/cards', 'GET', undefined, owner)).json(),
    );
    assert.ok(!html.includes(title), 'script content must be escaped');
    assert.equal('owner' in snapshot.cards[0], false);
    for (const cookie of ['', other]) {
      const data = initial(await (await request('/', 'GET', undefined, cookie)).text());
      assert.deepEqual(data.cards, []);
    }
    await request('/api/logout', 'POST', {}, owner);
    const revoked = initial(await (await request('/', 'GET', undefined, owner)).text());
    assert.equal(revoked.authenticated, false);
    assert.deepEqual(revoked.cards, []);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});
