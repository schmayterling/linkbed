import { createHash, createHmac, randomBytes } from 'node:crypto';
import { openDatabase } from './database.mjs';
import {
  normalizeCard,
  MAX_PAGE_BYTES,
  normalizeCustomBadges,
  pageBadges,
  normalizeSlug,
  normalizeReportLink,
  normalizeReportReason,
  cardComponents,
  componentUrls,
  payloadBytes,
  embedScript,
  embedJson,
} from './public/model.mjs';
import { fetchMetadata, publicUrl } from './metadata.mjs';
import { renderCard, renderEditor, renderNotFound } from './render.mjs';

export const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: http:; media-src 'self' https: http:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const clientAddress = (req) =>
  process.env.VERCEL
    ? req.headers['x-forwarded-for']?.split(',')[0].trim()
    : req.socket?.remoteAddress;
const cookie = (req, name) =>
  req.headers.cookie?.match(new RegExp('(?:^|;\\s*)' + name + '=([a-f0-9]{64})(?:;|$)'))?.[1];
const json = (res, status, data) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
};

function readCustomBadges(value) {
  try {
    const badges = normalizeCustomBadges(JSON.parse(value ?? 'null'));
    for (const badge of badges) publicUrl(badge.image, 'badge image url');
    return badges;
  } catch {
    return [];
  }
}

export function isLocalAdminRequest(req, address) {
  const loopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
  return (
    !process.env.VERCEL &&
    process.env.NODE_ENV !== 'production' &&
    /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host || '') &&
    !Object.keys(req.headers).some((name) =>
      /^(forwarded|x-forwarded-.*|x-real-ip|cf-connecting-ip)$/.test(name),
    ) &&
    loopback(req.socket?.remoteAddress) &&
    loopback(address)
  );
}

async function body(req, max = 16384) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'send json.');
  let value = req.body;
  if (value === undefined) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) throw fail(413, 'request is too large.');
      chunks.push(chunk);
    }
    try {
      value = JSON.parse(Buffer.concat(chunks));
    } catch {
      throw fail(400, 'invalid json.');
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > max) throw fail(413, 'request is too large.');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw fail(400, 'invalid json object.');
  return value;
}

const activeSessionSql =
  'EXISTS (SELECT 1 FROM sessions s LEFT JOIN accounts a ON a.token_hash = s.owner WHERE s.hash = ? AND s.owner = ? AND s.expires_at > ? AND a.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM owner_fingerprints o JOIN creator_fingerprints f ON f.fingerprint = o.fingerprint WHERE o.owner = s.owner AND f.banned_at IS NOT NULL))';

export function createHandler(options = {}) {
  const deploymentHost =
    process.env.VERCEL_ENV === 'production'
      ? process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL
      : process.env.VERCEL_URL;
  const origin =
    options.origin ||
    process.env.PUBLIC_ORIGIN ||
    (deploymentHost ? 'https://' + deploymentHost : 'http://localhost:3000');
  const canonical = new URL(origin).origin;
  let database;
  const connect = () =>
    (database ||= openDatabase(options).catch((error) => {
      database = undefined;
      throw error;
    }));

  function setCookie(res, name, token, maxAge = 2592000) {
    const value = `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${canonical.startsWith('https:') ? '; Secure' : ''}`;
    res.setHeader('set-cookie', [...(res.getHeader('set-cookie') || []), value]);
  }

  function fingerprintGuard(visitor, reporting = false) {
    return {
      sql: `NOT EXISTS (SELECT 1 FROM creator_fingerprints f WHERE (f.fingerprint = ? OR f.fingerprint IN (SELECT fingerprint FROM fingerprint_signatures WHERE signature = ?) OR f.fingerprint IN (SELECT b.fingerprint FROM owner_fingerprints a JOIN owner_fingerprints b ON a.owner = b.owner WHERE a.fingerprint = ?)) AND (f.banned_at IS NOT NULL${reporting ? ' OR f.reporting_banned_at IS NOT NULL' : ''}))`,
      args: [visitor.fingerprint, visitor.signature, visitor.fingerprint],
    };
  }

  async function identify(db, req, res, reporting) {
    let device = cookie(req, 'lembed_device');
    if (!device) {
      device = randomBytes(32).toString('hex');
      setCookie(res, 'lembed_device', device, 365 * 86400);
    }
    const visitor = {
      fingerprint: hash(device),
      signature: createHmac('sha256', db.fingerprintKey)
        .update(
          JSON.stringify([
            clientAddress(req) || 'unknown',
            (req.headers['user-agent'] || '').slice(0, 512),
          ]),
        )
        .digest('hex'),
    };
    // Anonymous bans combine a random browser id with a keyed network/browser signature.
    // A different network and browser can still bypass them.
    const guard = fingerprintGuard(visitor, reporting);
    const allowed = await db.execute({ sql: 'SELECT 1 WHERE ' + guard.sql, args: guard.args });
    if (!allowed.rows.length)
      throw fail(
        403,
        reporting
          ? 'you are not allowed to submit reports.'
          : 'you are not allowed to create or edit cards.',
      );
    await db.batch(
      [
        {
          sql: 'INSERT INTO creator_fingerprints (fingerprint, created_at) VALUES (?, ?) ON CONFLICT(fingerprint) DO NOTHING',
          args: [visitor.fingerprint, Date.now()],
        },
        {
          sql: 'INSERT INTO fingerprint_signatures (fingerprint, signature) VALUES (?, ?) ON CONFLICT DO NOTHING',
          args: [visitor.fingerprint, visitor.signature],
        },
      ],
      'write',
    );
    return visitor;
  }

  async function linkOwner(db, owner, visitor, reporting = false) {
    const banned = await db.execute({
      sql:
        'SELECT 1 FROM owner_fingerprints o JOIN creator_fingerprints f ON f.fingerprint = o.fingerprint WHERE o.owner = ? AND (f.banned_at IS NOT NULL' +
        (reporting ? ' OR f.reporting_banned_at IS NOT NULL' : '') +
        ') LIMIT 1',
      args: [owner],
    });
    if (banned.rows.length)
      throw fail(
        403,
        reporting
          ? 'you are not allowed to submit reports.'
          : 'you are not allowed to create or edit cards.',
      );
    await db.execute({
      sql: 'INSERT INTO owner_fingerprints (owner, fingerprint, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      args: [owner, visitor.fingerprint, Date.now()],
    });
    await db.execute({
      sql: 'UPDATE cards SET creator_fingerprint = ? WHERE owner = ? AND creator_fingerprint IS NULL',
      args: [visitor.fingerprint, owner],
    });
  }

  async function session(db, req) {
    const token = cookie(req, 'lembed_session');
    if (!token) return undefined;
    const result = await db.execute({
      sql: 'SELECT sessions.owner, sessions.expires_at, accounts.token_hash FROM sessions LEFT JOIN accounts ON accounts.token_hash = sessions.owner WHERE sessions.hash = ? AND sessions.expires_at > ? AND accounts.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM owner_fingerprints o JOIN creator_fingerprints f ON f.fingerprint = o.fingerprint WHERE o.owner = sessions.owner AND f.banned_at IS NOT NULL)',
      args: [hash(token), Date.now()],
    });
    const row = result.rows[0];
    return (
      row && {
        owner: row.owner,
        authenticated: !!row.token_hash,
        hash: hash(token),
        expiresAt: row.expires_at,
      }
    );
  }

  const sessionInfo = (current) => ({
    authenticated: !!current?.authenticated,
    guest: !!current && !current.authenticated,
  });

  async function listCards(db, current) {
    if (!current) return [];
    const result = await db.execute({
      sql:
        'SELECT slug, card, revision, updated_at, verified_at, sponsored_at, custom_badges FROM cards WHERE owner = ? AND ' +
        activeSessionSql +
        ' ORDER BY updated_at DESC',
      args: [current.owner, current.hash, current.owner, Date.now()],
    });
    return result.rows.map((row) => ({
      slug: row.slug,
      ...JSON.parse(row.card),
      revision: row.revision,
      updatedAt: row.updated_at,
      sponsored: row.sponsored_at != null,
      badges: pageBadges({
        verifiedAt: row.verified_at,
        sponsoredAt: row.sponsored_at,
        customBadges: readCustomBadges(row.custom_badges),
      }),
    }));
  }

  async function rate(db, req, kind, max) {
    const ip = clientAddress(req);
    const now = Date.now();
    const results = await db.batch(
      [
        { sql: 'DELETE FROM rate_limits WHERE expires_at < ?', args: [now] },
        {
          sql: 'INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count',
          args: [hash(kind + ':' + (ip || 'unknown')), now + 60000],
        },
      ],
      'write',
    );
    if (results[1].rows[0].count > max)
      throw fail(429, 'too many requests. wait a minute and try again.');
  }

  async function handle(req, res) {
    for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
    if (canonical.startsWith('https:'))
      res.setHeader('strict-transport-security', 'max-age=31536000');
    let pageRequest = false;
    try {
      const url = new URL(req.url, canonical);
      let path = url.pathname;
      if (path === '/api/index') {
        if (url.searchParams.has('home')) path = '/';
        else if (url.searchParams.has('card')) path = '/p/' + url.searchParams.get('card');
        else if (url.searchParams.has('route')) path = '/api/' + url.searchParams.get('route');
        else if (url.searchParams.has('health')) path = '/healthz';
      }
      const admin =
        path === '/admin' ||
        path.startsWith('/admin/') ||
        path === '/admin.mjs' ||
        path === '/api/admin' ||
        path.startsWith('/api/admin/');
      if (path === '/p/admin' || (admin && !options.allowAdmin?.(req)))
        throw fail(404, 'page not found.');
      pageRequest = !path.startsWith('/api/') && !admin && path !== '/healthz';
      if (
        /^\/(?:p\/)?404\/?$/.test(path) ||
        (path === '/api/index' && url.searchParams.has('notfound'))
      ) {
        pageRequest = true;
        throw fail(404, 'page not found.');
      }
      const write = !['GET', 'HEAD'].includes(req.method);
      if (
        write &&
        ![
          '/api/reports',
          '/api/guest',
          '/api/signup',
          '/api/login',
          '/api/logout',
          '/api/import',
        ].includes(path) &&
        !path.startsWith('/api/cards') &&
        !admin
      )
        throw fail(404, 'page not found.');

      if (path === '/' && ['GET', 'HEAD'].includes(req.method)) {
        let card, starter, initial;
        try {
          const db = await connect();
          const result = await db.execute(
            "SELECT slug, card FROM cards WHERE slug IN ('linkbed', 'may') AND NOT EXISTS (SELECT 1 FROM banned_slugs WHERE slug = cards.slug)",
          );
          for (const row of result.rows) {
            if (row.slug === 'linkbed') card = JSON.parse(row.card);
            else starter = JSON.parse(row.card);
          }
          const current = await session(db, req);
          initial = { ...sessionInfo(current), cards: await listCards(db, current) };
        } catch (error) {
          console.error('homepage embed unavailable:', error.code || error.name);
        }
        const html = renderEditor(card, canonical + '/', starter, initial);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, no-store',
          vary: 'Cookie',
        });
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      const db = await connect();
      if (write) {
        const origins = admin ? ['http://' + req.headers.host] : [canonical];
        if (!admin && process.env.VERCEL_URL) origins.push('https://' + process.env.VERCEL_URL);
        if (!origins.includes(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site')
          throw fail(403, 'request must come from this site.');
        await rate(db, req, 'write', 60);
      }
      const visitor =
        write && !admin && path !== '/api/logout'
          ? await identify(db, req, res, path === '/api/reports')
          : null;
      if (req.method === 'GET' && path === '/healthz') {
        await db.execute('SELECT 1');
        return json(res, 200, { status: 'ok' });
      }
      if (req.method === 'POST' && path === '/api/reports') {
        await rate(db, req, 'report', 5);
        const input = await body(req);
        if (input.confirmed !== true)
          throw fail(400, 'confirm that this link contains abusive content.');
        const link = normalizeReportLink(input.url, canonical);
        const { reason, details } = normalizeReportReason(input);
        const current = await session(db, req);
        if (current) await linkOwner(db, current.owner, visitor, true);
        const guard = fingerprintGuard(visitor, true);
        const result = await db.execute({
          sql:
            'INSERT INTO abuse_reports (slug, url, reason, details, created_at, reporter_fingerprint) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cards WHERE slug = ?) AND ' +
            guard.sql +
            ' RETURNING id',
          args: [
            link.slug,
            link.url,
            reason,
            details,
            Date.now(),
            visitor.fingerprint,
            link.slug,
            ...guard.args,
          ],
        });
        if (!result.rows.length)
          throw fail(404, 'that link could not be found or reporting is unavailable.');
        return json(res, 201, { reported: true });
      }
      if (admin) {
        if (req.method === 'GET' && ['/api/admin/cards', '/api/admin/reports'].includes(path)) {
          const offset = Number(url.searchParams.get('offset') || 0);
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000)
            throw fail(400, 'invalid page.');
          const search = (url.searchParams.get('q') || '').trim();
          if (search.length > 200) throw fail(400, 'search is too long.');
          const reports = path === '/api/admin/reports';
          const result = await db.execute(
            reports
              ? {
                  sql: "SELECT r.id, r.slug, r.url, r.reason, r.details, r.created_at, r.reporter_fingerprint, json_extract(c.card, '$.title') AS title, c.sponsored_at, c.verified_at, c.custom_badges, c.creator_fingerprint, c.slug IS NULL AS removed, (SELECT token_hash FROM accounts WHERE token_hash = c.owner AND revoked_at IS NULL) AS token_hash, EXISTS (SELECT 1 FROM banned_slugs WHERE slug = r.slug) AS banned FROM abuse_reports r LEFT JOIN cards c ON c.slug = r.slug WHERE r.resolved_at IS NULL ORDER BY r.created_at, r.id LIMIT 51 OFFSET ?",
                  args: [offset],
                }
              : {
                  sql: "SELECT c.slug, json_extract(c.card, '$.title') AS title, json_extract(c.card, '$.url') AS destination, c.revision, c.updated_at, c.sponsored_at, c.verified_at, c.custom_badges, c.creator_fingerprint, (SELECT token_hash FROM accounts WHERE token_hash = c.owner AND revoked_at IS NULL) AS token_hash, EXISTS (SELECT 1 FROM banned_slugs WHERE slug = c.slug) AS banned FROM cards c WHERE instr(lower(c.slug), lower(?)) > 0 OR instr(lower(c.card), lower(?)) > 0 ORDER BY c.updated_at DESC, c.slug LIMIT 51 OFFSET ?",
                  args: [search, search, offset],
                },
          );
          return json(res, 200, {
            items: result.rows.slice(0, 50).map(({ custom_badges, ...row }) => ({
              ...row,
              customBadges: readCustomBadges(custom_badges),
              link: canonical + '/' + row.slug,
            })),
            hasMore: result.rows.length > 50,
          });
        }
        if (
          req.method === 'GET' &&
          ['/api/admin/tokens', '/api/admin/fingerprints', '/api/admin/slugs'].includes(path)
        ) {
          const offset = Number(url.searchParams.get('offset') || 0);
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000)
            throw fail(400, 'invalid page.');
          const queries = {
            '/api/admin/tokens':
              'SELECT a.token_hash, a.created_at, a.revoked_at, (SELECT COUNT(*) FROM cards WHERE owner = a.token_hash) AS cards FROM accounts a ORDER BY a.created_at DESC, a.token_hash LIMIT 51 OFFSET ?',
            '/api/admin/fingerprints':
              'SELECT f.fingerprint, f.created_at, f.banned_at, f.reporting_banned_at, (SELECT COUNT(*) FROM owner_fingerprints WHERE fingerprint = f.fingerprint) AS identities FROM creator_fingerprints f ORDER BY f.created_at DESC, f.fingerprint LIMIT 51 OFFSET ?',
            '/api/admin/slugs':
              'SELECT slug, banned_at FROM banned_slugs ORDER BY banned_at DESC, slug LIMIT 51 OFFSET ?',
          };
          const result = await db.execute({ sql: queries[path], args: [offset] });
          return json(res, 200, {
            items: result.rows.slice(0, 50),
            hasMore: result.rows.length > 50,
          });
        }
        const slugBan = path.match(/^\/api\/admin\/slugs\/([a-z0-9-]+)\/(ban|unban)$/);
        if (slugBan && req.method === 'POST') {
          await body(req);
          const slug = normalizeSlug(slugBan[1]);
          await db.execute(
            slugBan[2] === 'ban'
              ? {
                  sql: 'INSERT INTO banned_slugs (slug, banned_at) VALUES (?, ?) ON CONFLICT(slug) DO NOTHING',
                  args: [slug, Date.now()],
                }
              : { sql: 'DELETE FROM banned_slugs WHERE slug = ?', args: [slug] },
          );
          return json(res, 200, { banned: slugBan[2] === 'ban' });
        }
        const fingerprintBan = path.match(
          /^\/api\/admin\/fingerprints\/([a-f0-9]{64})\/(ban|unban|ban-reporting|unban-reporting)$/,
        );
        if (fingerprintBan && req.method === 'POST') {
          await body(req);
          const [, fingerprint, action] = fingerprintBan;
          const reporting = action.endsWith('reporting'),
            ban = action.startsWith('ban');
          const column = reporting ? 'reporting_banned_at' : 'banned_at';
          const commands = [
            {
              sql:
                'UPDATE creator_fingerprints SET ' +
                column +
                ' = ? WHERE fingerprint = ? RETURNING fingerprint',
              args: [ban ? Date.now() : null, fingerprint],
            },
          ];
          if (ban && !reporting)
            commands.push(
              {
                sql: 'UPDATE accounts SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash IN (SELECT owner FROM owner_fingerprints WHERE fingerprint = ?)',
                args: [Date.now(), fingerprint],
              },
              {
                sql: 'DELETE FROM sessions WHERE owner IN (SELECT owner FROM owner_fingerprints WHERE fingerprint = ?)',
                args: [fingerprint],
              },
            );
          const results = await db.batch(commands, 'write');
          if (!results[0].rows.length) throw fail(404, 'fingerprint not found.');
          return json(res, 200, { banned: ban });
        }
        const tokenRevoke = path.match(/^\/api\/admin\/tokens\/([a-f0-9]{64})\/revoke$/);
        if (tokenRevoke && req.method === 'POST') {
          await body(req);
          const results = await db.batch(
            [
              {
                sql: 'UPDATE accounts SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ? RETURNING token_hash',
                args: [Date.now(), tokenRevoke[1]],
              },
              { sql: 'DELETE FROM sessions WHERE owner = ?', args: [tokenRevoke[1]] },
            ],
            'write',
          );
          if (!results[0].rows.length) throw fail(404, 'token not found.');
          return json(res, 200, { revoked: true });
        }
        const report = path.match(/^\/api\/admin\/reports\/([1-9]\d*)\/dismiss$/);
        if (report && req.method === 'POST') {
          await body(req);
          const id = Number(report[1]);
          if (!Number.isSafeInteger(id)) throw fail(400, 'invalid report.');
          const result = await db.execute({
            sql: 'UPDATE abuse_reports SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL RETURNING id',
            args: [Date.now(), id],
          });
          if (!result.rows.length) throw fail(404, 'report not found.');
          return json(res, 200, { dismissed: true });
        }
        const statusBadge = path.match(/^\/api\/admin\/cards\/([a-z0-9-]+)\/(sponsor|verify)$/);
        if (statusBadge && ['POST', 'DELETE'].includes(req.method)) {
          if (req.method === 'POST') await body(req);
          const column = { sponsor: 'sponsored_at', verify: 'verified_at' }[statusBadge[2]];
          const result = await db.execute({
            sql:
              'UPDATE cards SET ' +
              column +
              ' = ' +
              (req.method === 'POST' ? 'COALESCE(' + column + ', ?)' : '?') +
              ' WHERE slug = ? RETURNING ' +
              column,
            args: [req.method === 'POST' ? Date.now() : null, statusBadge[1]],
          });
          if (!result.rows.length) throw fail(404, 'card not found.');
          return json(res, 200, { [column]: result.rows[0][column] });
        }
        const customBadges = path.match(/^\/api\/admin\/cards\/([a-z0-9-]+)\/badges$/);
        if (customBadges && req.method === 'PUT') {
          const input = await body(req, 65536);
          if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'badges'))
            throw fail(400, 'provide a badges array.');
          const badges = normalizeCustomBadges(input.badges);
          for (const badge of badges) publicUrl(badge.image, 'badge image url');
          const result = await db.execute({
            sql: 'UPDATE cards SET custom_badges = ? WHERE slug = ? RETURNING custom_badges',
            args: [badges.length ? JSON.stringify(badges) : null, customBadges[1]],
          });
          if (!result.rows.length) throw fail(404, 'card not found.');
          return json(res, 200, { customBadges: readCustomBadges(result.rows[0].custom_badges) });
        }
        const card = path.match(/^\/api\/admin\/cards\/([a-z0-9-]+)$/);
        if (card && req.method === 'DELETE') {
          const results = await db.batch(
            [
              { sql: 'DELETE FROM cards WHERE slug = ? RETURNING slug', args: [card[1]] },
              {
                sql: 'UPDATE abuse_reports SET resolved_at = ? WHERE slug = ? AND resolved_at IS NULL',
                args: [Date.now(), card[1]],
              },
            ],
            'write',
          );
          return json(res, 200, { deleted: results[0].rows.length > 0 });
        }
        throw fail(404, 'page not found.');
      }
      if (req.method === 'GET' && path === '/api/session')
        return json(res, 200, sessionInfo(await session(db, req)));
      if (req.method === 'POST' && path === '/api/guest') {
        await body(req);
        const current = await session(db, req);
        if (current) {
          await linkOwner(db, current.owner, visitor);
          return json(res, 200, sessionInfo(current));
        }
        const expiresAt = Date.now() + 365 * 86400000;
        await rate(db, req, 'guest', 10);
        const sessionToken = randomBytes(32).toString('hex');
        const legacy = cookie(req, 'lembed_owner');
        const owner = 'guest:' + randomBytes(32).toString('hex');
        await linkOwner(db, owner, visitor);
        const commands = [
          {
            sql: 'INSERT INTO sessions (hash, owner, expires_at) VALUES (?, ?, ?)',
            args: [hash(sessionToken), owner, expiresAt],
          },
        ];
        if (legacy)
          commands.push({
            sql: 'UPDATE cards SET owner = ? WHERE owner = ?',
            args: [owner, hash(legacy)],
          });
        await db.batch(commands, 'write');
        setCookie(res, 'lembed_session', sessionToken, 365 * 86400);
        if (legacy) setCookie(res, 'lembed_owner', '', 0);
        return json(res, 201, sessionInfo({ authenticated: false, expiresAt }));
      }
      if (req.method === 'POST' && (path === '/api/signup' || path === '/api/login')) {
        await rate(db, req, 'auth', 10);
        const current = await session(db, req);
        if (path === '/api/signup' && current?.authenticated) throw fail(409, 'already signed in.');
        let owner;
        let token;
        if (path === '/api/signup') {
          token = 'lembed_' + randomBytes(32).toString('base64url');
          owner = hash(token);
        } else {
          const input = await body(req);
          if (typeof input.token !== 'string' || !/^lembed_[A-Za-z0-9_-]{43}$/.test(input.token))
            throw fail(401, 'token not recognized.');
          owner = hash(input.token);
          const found = await db.execute({
            sql: 'SELECT token_hash FROM accounts WHERE token_hash = ? AND revoked_at IS NULL',
            args: [owner],
          });
          if (!found.rows.length) throw fail(401, 'token not recognized.');
        }
        await linkOwner(db, owner, visitor);
        const sessionToken = randomBytes(32).toString('hex');
        const guard = fingerprintGuard(visitor);
        const commands = [
          { sql: 'DELETE FROM sessions WHERE expires_at < ?', args: [Date.now()] },
          {
            sql:
              'INSERT INTO sessions (hash, owner, expires_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM accounts WHERE token_hash = ? AND revoked_at IS NULL) AND ' +
              guard.sql +
              ' RETURNING hash',
            args: [hash(sessionToken), owner, Date.now() + 2592000000, owner, ...guard.args],
          },
        ];
        if (token)
          commands.unshift({
            sql: 'INSERT INTO accounts (token_hash, created_at) SELECT ?, ? WHERE ' + guard.sql,
            args: [owner, Date.now(), ...guard.args],
          });
        if (current && !current.authenticated) {
          await linkOwner(db, current.owner, visitor);
          commands.push(
            {
              sql: 'INSERT INTO owner_fingerprints (owner, fingerprint, created_at) SELECT ?, fingerprint, created_at FROM owner_fingerprints WHERE owner = ? ON CONFLICT DO NOTHING',
              args: [owner, current.owner],
            },
            {
              sql: 'UPDATE cards SET owner = ? WHERE owner = ? AND EXISTS (SELECT 1 FROM sessions WHERE hash = ? AND expires_at > ?) AND EXISTS (SELECT 1 FROM sessions WHERE hash = ? AND owner = ?)',
              args: [owner, current.owner, current.hash, Date.now(), hash(sessionToken), owner],
            },
            {
              sql: 'DELETE FROM sessions WHERE owner = ? AND EXISTS (SELECT 1 FROM sessions WHERE hash = ? AND owner = ?)',
              args: [current.owner, hash(sessionToken), owner],
            },
          );
        }
        const legacy = cookie(req, 'lembed_owner');
        if (legacy)
          commands.push({
            sql: 'UPDATE cards SET owner = ? WHERE owner = ? AND EXISTS (SELECT 1 FROM sessions WHERE hash = ? AND owner = ?)',
            args: [owner, hash(legacy), hash(sessionToken), owner],
          });
        const results = await db.batch(commands, 'write');
        if (!results[token ? 2 : 1].rows.length) throw fail(403, 'access is no longer available.');
        setCookie(res, 'lembed_session', sessionToken);
        if (legacy) setCookie(res, 'lembed_owner', '', 0);
        return json(
          res,
          token ? 201 : 200,
          token ? { authenticated: true, token } : { authenticated: true },
        );
      }
      if (req.method === 'POST' && path === '/api/logout') {
        const current = await session(db, req);
        if (current && !current.authenticated) return json(res, 200, sessionInfo(current));
        if (current)
          await db.execute({ sql: 'DELETE FROM sessions WHERE hash = ?', args: [current.hash] });
        setCookie(res, 'lembed_session', '', 0);
        return json(res, 200, { authenticated: false });
      }
      if (req.method === 'POST' && path === '/api/import') {
        await rate(db, req, 'import', 10);
        const input = await body(req);
        try {
          return json(res, 200, await fetchMetadata(input.url));
        } catch (error) {
          if (error.status) throw error;
          throw fail(400, 'could not import that website. fill in the card manually.');
        }
      }
      if (path === '/api/cards' || path.startsWith('/api/cards/')) {
        const current = await session(db, req);
        if (!current) {
          if (path === '/api/cards' && req.method === 'GET') return json(res, 200, []);
          throw fail(
            401,
            'edit access expired. start a new card or sign in with your access token.',
          );
        }
        const { owner } = current;
        if (write) await linkOwner(db, owner, visitor);
        const guard = visitor ? fingerprintGuard(visitor) : { sql: '1', args: [] };
        const activeSession = activeSessionSql + ' AND ' + guard.sql;
        const access = () => [current.hash, owner, Date.now(), ...guard.args];
        if (path === '/api/cards' && req.method === 'GET') {
          return json(res, 200, await listCards(db, current));
        }
        const api = path.match(/^\/api\/cards\/([a-z0-9-]+)$/);
        if (api && req.method === 'GET') {
          const result = await db.execute({
            sql:
              'SELECT card, revision, sponsored_at FROM cards WHERE slug = ? AND owner = ? AND ' +
              activeSession,
            args: [api[1], owner, ...access()],
          });
          if (!result.rows.length) throw fail(404, 'card not found.');
          return json(res, 200, {
            slug: api[1],
            ...JSON.parse(result.rows[0].card),
            revision: result.rows[0].revision,
            sponsored: result.rows[0].sponsored_at != null,
          });
        }
        if (api && req.method === 'DELETE') {
          const result = await db.execute({
            sql:
              'DELETE FROM cards WHERE slug = ? AND owner = ? AND ' +
              activeSession +
              ' RETURNING slug',
            args: [api[1], owner, ...access()],
          });
          if (!result.rows.length) throw fail(404, 'card not found.');
          return json(res, 200, { deleted: true });
        }
        const create = path === '/api/cards' && req.method === 'POST';
        if (!create && !(api && req.method === 'PUT')) throw fail(405, 'method not allowed.');
        const input = await body(req, MAX_PAGE_BYTES);
        const slug = normalizeSlug(input.slug ?? api?.[1]);
        const forbidden = await db.execute({
          sql: 'SELECT slug FROM banned_slugs WHERE slug = ? OR slug = ?',
          args: [slug, api?.[1] || slug],
        });
        if (forbidden.rows.length) throw fail(403, 'this link is banned.');
        const now = Date.now();
        const card = normalizeCard(input, `${canonical}/${slug}`);
        if (card.url) publicUrl(card.url);
        if (card.seo?.image) publicUrl(card.seo.image, 'seo image url');
        if (card.seo?.favicon) publicUrl(card.seo.favicon, 'seo favicon url');
        for (const link of cardComponents(card).flatMap(componentUrls))
          publicUrl(link, 'component url', true);
        let result;
        try {
          if (create) {
            result = await db.execute({
              sql:
                'INSERT INTO cards (slug, owner, card, revision, updated_at, creator_fingerprint) SELECT ?, ?, ?, 1, ?, ? WHERE (SELECT COUNT(*) FROM cards WHERE owner = ?) < 100 AND ' +
                activeSession +
                ' AND NOT EXISTS (SELECT 1 FROM banned_slugs WHERE slug = ?) RETURNING revision',
              args: [
                slug,
                owner,
                JSON.stringify(card),
                now,
                visitor.fingerprint,
                owner,
                ...access(),
                slug,
              ],
            });
            if (!result.rows.length) {
              if (!(await session(db, req)))
                throw fail(401, 'edit access expired. sign in with your access token.');
              throw fail(400, 'you have reached the 100-card limit.');
            }
          } else {
            result = await db.execute({
              sql:
                "UPDATE cards SET slug = ?, card = ?, revision = revision + 1, updated_at = ?, verified_at = CASE WHEN slug = ? AND json_extract(card, '$.url') IS ? THEN verified_at ELSE NULL END WHERE slug = ? AND owner = ? AND " +
                activeSession +
                ' AND NOT EXISTS (SELECT 1 FROM banned_slugs WHERE slug = ? OR slug = ?) RETURNING revision',
              args: [
                slug,
                JSON.stringify(card),
                now,
                slug,
                card.url,
                api[1],
                owner,
                ...access(),
                slug,
                api[1],
              ],
            });
            if (!result.rows.length) throw fail(404, 'card not found.');
          }
        } catch (error) {
          if (
            String(error.code).includes('SQLITE_CONSTRAINT') ||
            /UNIQUE constraint failed/.test(error.message)
          )
            throw fail(409, 'that link is taken. choose another.');
          throw error;
        }
        const revision = result.rows[0].revision;
        return json(res, create ? 201 : 200, {
          slug,
          revision,
          url: `${canonical}/${slug}`,
          freshUrl: `${canonical}/${slug}?v=${revision}`,
          bytes: payloadBytes(card),
          script: embedScript(card),
        });
      }
      const publicPage = path.match(/^\/(?:p\/)?([a-z0-9-]+)$/);
      const publicEmbed = path.match(/^\/api\/embeds\/([a-z0-9-]+)$/);
      if ((publicPage || publicEmbed) && ['GET', 'HEAD'].includes(req.method)) {
        const slug = (publicPage || publicEmbed)[1];
        const result = await db.execute({
          sql: 'SELECT card, sponsored_at, verified_at, custom_badges FROM cards WHERE slug = ? AND NOT EXISTS (SELECT 1 FROM banned_slugs WHERE slug = cards.slug)',
          args: [slug],
        });
        if (!result.rows.length) throw fail(404, 'card not found.');
        const card = JSON.parse(result.rows[0].card);
        const content = publicEmbed
          ? embedJson(card)
          : renderCard(card, `${canonical}/${slug}`, {
              sponsoredAt: result.rows[0].sponsored_at,
              verifiedAt: result.rows[0].verified_at,
              customBadges: readCustomBadges(result.rows[0].custom_badges),
            });
        res.writeHead(200, {
          'content-type': publicEmbed
            ? 'application/json; charset=utf-8'
            : 'text/html; charset=utf-8',
          'cache-control': publicEmbed ? 'no-store' : 'public, max-age=60',
        });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      throw fail(404, 'page not found.');
    } catch (error) {
      if (!error.status) console.error('lembed request failed:', error.code || error.name);
      if (!res.headersSent) {
        if (error.status === 404 && pageRequest && ['GET', 'HEAD'].includes(req.method)) {
          res.writeHead(404, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-robots-tag': 'noindex',
          });
          return res.end(req.method === 'HEAD' ? undefined : renderNotFound(canonical + '/'));
        }
        json(res, error.status || 500, {
          error: error.status ? error.message : 'service unavailable. try again shortly.',
        });
      } else res.end();
    }
  }
  handle.close = async () => {
    const current = database;
    database = undefined;
    (await current)?.close();
  };
  return handle;
}
