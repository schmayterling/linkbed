import type { ServerResponse } from 'node:http';
import { readCustomBadges, validateCustomBadges } from '../card-badges.ts';
import type { Database } from '../database.ts';
import { body, fail, json } from '../http.ts';
import type { HandlerRequest } from '../http.ts';
import { normalizeSlug } from '../public/model.mts';

function pageOffset(params: URLSearchParams) {
  const offset = Number(params.get('offset') || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000)
    throw fail(400, 'invalid page.');
  return offset;
}

export async function handleAdminRequest(
  db: Database,
  req: HandlerRequest,
  res: ServerResponse,
  path: string,
  params: URLSearchParams,
  canonical: string,
): Promise<void> {
  if (req.method === 'GET' && ['/api/admin/cards', '/api/admin/reports'].includes(path)) {
    const offset = pageOffset(params);
    const search = (params.get('q') || '').trim();
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
    // Both admin queries select the slug and nullable custom-badge JSON.
    const rows = result.rows as { slug: string; custom_badges: string | null }[];
    return json(res, 200, {
      items: rows.slice(0, 50).map(({ custom_badges, ...row }) => ({
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
    const offset = pageOffset(params);
    const queries = {
      '/api/admin/tokens':
        'SELECT a.token_hash, a.created_at, a.revoked_at, (SELECT COUNT(*) FROM cards WHERE owner = a.token_hash) AS cards FROM accounts a ORDER BY a.created_at DESC, a.token_hash LIMIT 51 OFFSET ?',
      '/api/admin/fingerprints':
        'SELECT f.fingerprint, f.created_at, f.banned_at, f.reporting_banned_at, (SELECT COUNT(*) FROM owner_fingerprints WHERE fingerprint = f.fingerprint) AS identities FROM creator_fingerprints f ORDER BY f.created_at DESC, f.fingerprint LIMIT 51 OFFSET ?',
      '/api/admin/slugs':
        'SELECT slug, banned_at FROM banned_slugs ORDER BY banned_at DESC, slug LIMIT 51 OFFSET ?',
    };
    // The route check above lists exactly the three keys of queries.
    const result = await db.execute({
      sql: queries[path as keyof typeof queries],
      args: [offset],
    });
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
    // The second regex capture is either sponsor or verify.
    const column = { sponsor: 'sponsored_at', verify: 'verified_at' }[
      statusBadge[2] as 'sponsor' | 'verify'
    ];
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
    // UPDATE returns the selected nullable timestamp column.
    const updatedAt = result.rows[0][column] as number | null;
    return json(res, 200, { [column]: updatedAt });
  }
  const customBadges = path.match(/^\/api\/admin\/cards\/([a-z0-9-]+)\/badges$/);
  if (customBadges && req.method === 'PUT') {
    const input = await body(req, 65536);
    if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'badges'))
      throw fail(400, 'provide a badges array.');
    const badges = validateCustomBadges(input.badges);
    const result = await db.execute({
      sql: 'UPDATE cards SET custom_badges = ? WHERE slug = ? RETURNING custom_badges',
      args: [badges.length ? JSON.stringify(badges) : null, customBadges[1]],
    });
    if (!result.rows.length) throw fail(404, 'card not found.');
    // UPDATE returns the nullable TEXT column just assigned above.
    const row = result.rows[0] as { custom_badges: string | null };
    return json(res, 200, { customBadges: readCustomBadges(row.custom_badges) });
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
