import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.ts';

test('layered creator and reporting bans persist, revoke linked tokens, and allow explicit unbans', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-bans-'));
  const dbPath = join(directory, 'cards.sqlite');
  const { server, close } = createApp({ dbPath, origin: 'http://localhost:3000' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  // The TCP listener has emitted 'listening', so address() returns AddressInfo.
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const request = (
    path: string,
    method = 'GET',
    data?: unknown,
    cookie = '',
    agent = 'moderation-test/1',
  ) =>
    fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: path.startsWith('/api/admin') ? base : 'http://localhost:3000',
        cookie,
        'user-agent': agent,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  let inspect: DatabaseSync | undefined;
  try {
    const signup = await request('/api/signup', 'POST', {});
    assert.equal(signup.status, 201);
    const { token }: { token: unknown } = await signup.json();
    const cookies = signup.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    // A successful signup sets the visitor's device cookie.
    const device = (cookies.match(/lembed_device=([a-f0-9]{64})/) as RegExpMatchArray)[1];
    const card = {
      slug: 'moderation-test',
      title: 'test',
      url: 'https://example.com',
      description: '',
      color: '#5865f2',
      images: [],
      buttons: [],
    };
    assert.equal((await request('/api/cards', 'POST', card, cookies)).status, 201);
    inspect = new DatabaseSync(dbPath);
    // The preceding successful insert populated the creator fingerprint for this slug.
    const saved = inspect
      .prepare('SELECT creator_fingerprint FROM cards WHERE slug = ?')
      .get(card.slug) as { creator_fingerprint: string };
    assert.equal(saved.creator_fingerprint.length, 64);
    assert.notEqual(saved.creator_fingerprint, device);
    assert.ok(
      !JSON.stringify(inspect.prepare('SELECT * FROM fingerprint_signatures').all()).includes(
        'moderation-test/1',
      ),
    );
    assert.ok(
      !JSON.stringify(inspect.prepare('SELECT * FROM fingerprint_signatures').all()).includes(
        '127.0.0.1',
      ),
    );
    // Database initialization creates the fingerprint key.
    const originalKey = (
      inspect.prepare("SELECT value FROM app_settings WHERE key = 'fingerprint_key'").get() as {
        value: string;
      }
    ).value;
    // signup created the sole account in this database.
    const originalToken = (
      inspect.prepare('SELECT token_hash FROM accounts').get() as { token_hash: string }
    ).token_hash;

    assert.equal(
      (
        await request(
          '/api/reports',
          'POST',
          { url: 'https://linkbed.me/' + card.slug, confirmed: true, reason: 'spam or scams' },
          cookies,
        )
      ).status,
      201,
    );
    const report = (
      await request('/api/admin/reports').then(
        (r): Promise<{ items: { reporter_fingerprint: unknown }[] }> => r.json(),
      )
    ).items[0];
    assert.equal(report.reporter_fingerprint, saved.creator_fingerprint);

    const moderate = (action: string) =>
      request('/api/admin/fingerprints/' + saved.creator_fingerprint + '/' + action, 'POST', {});
    assert.equal((await moderate('ban-reporting')).status, 200);
    assert.equal(
      (
        await request(
          '/api/reports',
          'POST',
          { url: 'https://linkbed.me/' + card.slug, confirmed: true, reason: 'spam or scams' },
          cookies,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          '/api/cards/' + card.slug,
          'PUT',
          { ...card, title: 'still editable' },
          cookies,
        )
      ).status,
      200,
    );
    assert.equal((await request('/api/guest', 'POST', {}, '', 'moderation-test/1')).status, 201);
    assert.equal(
      (
        await request(
          '/api/reports',
          'POST',
          { url: 'https://linkbed.me/' + card.slug, confirmed: true, reason: 'spam or scams' },
          '',
          'moderation-test/1',
        )
      ).status,
      403,
    );
    assert.equal((await moderate('unban-reporting')).status, 200);
    assert.equal(
      (
        await request(
          '/api/reports',
          'POST',
          { url: 'https://linkbed.me/' + card.slug, confirmed: true, reason: 'spam or scams' },
          cookies,
        )
      ).status,
      201,
    );

    // A second browser linked to the account must also lose access.
    const secondLogin = await request('/api/login', 'POST', { token }, '', 'moderation-test/2');
    assert.equal(secondLogin.status, 200);
    const secondCookies = secondLogin.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    assert.equal((await moderate('ban')).status, 200);
    assert.ok(
      // The seed account persists after revocation.
      (
        inspect
          .prepare('SELECT revoked_at FROM accounts WHERE token_hash = ?')
          .get(originalToken) as { revoked_at: unknown }
      ).revoked_at,
    );
    assert.equal(
      // COUNT(*) returns one row even when there are no sessions.
      (
        inspect
          .prepare('SELECT COUNT(*) AS count FROM sessions WHERE owner = ?')
          .get(originalToken) as { count: number }
      ).count,
      0,
    );
    assert.equal((await request('/api/guest', 'POST', {}, cookies)).status, 403);
    assert.equal(
      (await request('/api/cards/' + card.slug, 'PUT', card, secondCookies, 'moderation-test/2'))
        .status,
      403,
    );
    assert.equal((await request('/api/signup', 'POST', {}, '', 'moderation-test/1')).status, 403);
    assert.equal(
      (await request('/api/login', 'POST', { token }, '', 'unrelated-browser')).status,
      401,
    );
    assert.equal(
      (
        await request(
          '/api/reports',
          'POST',
          { url: 'https://linkbed.me/' + card.slug, confirmed: true, reason: 'spam or scams' },
          cookies,
        )
      ).status,
      403,
    );

    assert.equal((await moderate('unban')).status, 200);
    assert.equal((await request('/api/guest', 'POST', {}, cookies)).status, 201);
    assert.equal((await request('/api/login', 'POST', { token }, cookies)).status, 401);
    assert.equal(
      // Unbanning preserves the fingerprint key row.
      (
        inspect.prepare("SELECT value FROM app_settings WHERE key = 'fingerprint_key'").get() as {
          value: string;
        }
      ).value,
      originalKey,
    );
    assert.equal((await request('/' + card.slug)).status, 200);
  } finally {
    inspect?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
