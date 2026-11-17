import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkedEmbedCode } from '../public/interchange.mjs';

test('live embed stays on the destination host and proxies only bounded public JSON', async () => {
  const source = 'https://linkbed.me/api/embeds/may';
  const code = linkedEmbedCode('https://ryanaque.com/work?view=all', source);
  assert.equal(
    code.head,
    '<link rel="discord:component-embed" type="application/json" href="https://ryanaque.com/linkbed.json">',
  );
  assert.throws(() => linkedEmbedCode('javascript:alert(1)', source));
  assert.equal(
    linkedEmbedCode(null, source).head,
    '<link rel="discord:component-embed" type="application/json" href="https://your-site.com/linkbed.json">',
  );
  const { GET } = await import(
    'data:text/javascript;base64,' + Buffer.from(code.route).toString('base64')
  );
  const originalFetch = globalThis.fetch;
  try {
    const body = JSON.stringify({
      component: { type: 17, components: [{ type: 10, content: 'latest' }] },
    });
    globalThis.fetch = async (url, options) => {
      assert.equal(url, source);
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(body);
    };
    const response = await GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(await response.text(), body);
    for (const invalid of [
      '<html>not json</html>',
      '{}',
      JSON.stringify({ component: { type: 17 }, extra: 'x'.repeat(3000) }),
    ]) {
      globalThis.fetch = async () => new Response(invalid);
      const result = await GET();
      assert.equal(result.status, 502);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.equal(await result.text(), '');
    }
    globalThis.fetch = async () => new Response(null, { status: 404 });
    assert.equal((await GET()).status, 502);
    globalThis.fetch = async () => {
      throw new Error('upstream unavailable');
    };
    assert.equal((await GET()).status, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
