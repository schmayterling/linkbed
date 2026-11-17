import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { PAGE_COLORS, normalizeCard, embedJson } from '../public/model.mjs';
import { importCardJson, messageJson } from '../public/interchange.mjs';
import { renderCard } from '../render.mjs';
import { createApp } from '../server.mjs';

const component = { type: 17, components: [{ type: 10, content: 'page card' }] };
const page = { title: 'page', url: null, component };
const colors = {
  light: {
    background: '#ABCDEF',
    card: '#FEDCBA',
    text: '#112233',
    links: '#445566',
    button: '#AABBCC',
    button_text: '#DDEEFF',
  },
  dark: { ...PAGE_COLORS.dark },
};
const normalizedColors = {
  ...colors,
  light: {
    ...colors.light,
    background: '#abcdef',
    card: '#fedcba',
    button: '#aabbcc',
    button_text: '#ddeeff',
  },
};

test('page appearance normalizes, omits empty settings, preserves native imports and leaves Discord unchanged', () => {
  const card = normalizeCard({
    ...page,
    page_theme: 'light',
    page_color_scheme: 'dark',
    page_colors: colors,
  });
  assert.equal(card.page_theme, 'light');
  assert.equal(card.page_color_scheme, 'dark');
  assert.deepEqual(card.page_colors, normalizedColors);
  assert.deepEqual(
    importCardJson({
      component,
      page_theme: 'light',
      page_color_scheme: 'dark',
      page_colors: colors,
    }),
    {
      component,
      page_theme: 'light',
      page_color_scheme: 'dark',
      page_colors: normalizedColors,
    },
  );
  assert.deepEqual(JSON.parse(embedJson(card)), { component });
  assert.deepEqual(JSON.parse(messageJson(card)).components, [component]);
  assert.equal(normalizeCard({ ...card, url: 'https://example.com/' }).page_theme, 'light');
  for (const page_theme of [undefined, null, 'auto']) {
    assert.equal('page_theme' in normalizeCard({ ...page, page_theme }), false);
  }
  for (const page_color_scheme of [undefined, null, 'auto']) {
    assert.equal('page_color_scheme' in normalizeCard({ ...page, page_color_scheme }), false);
  }
  for (const page_colors of [
    undefined,
    null,
    {},
    { light: {}, dark: null },
    { light: { background: '', card: null } },
  ]) {
    assert.equal('page_colors' in normalizeCard({ ...page, page_colors }), false);
  }
});

test('appearance rejects unknown fields, non-hex colors and invalid themes', () => {
  for (const page_theme of ['', 'system', 'LIGHT', false, 0, {}, []]) {
    assert.throws(() => normalizeCard({ ...page, page_theme }));
    assert.throws(() => normalizeCard({ ...page, page_color_scheme: page_theme }));
  }
  for (const page_colors of [
    [],
    false,
    'red',
    { system: {} },
    { light: [] },
    { light: '#abcdef' },
    { light: { url: '#abcdef' } },
  ]) {
    assert.throws(() => normalizeCard({ ...page, page_colors }));
  }
  for (const background of [
    'red',
    '#abc',
    '#12345678',
    'url(https://example.com/image.png)',
    'https://example.com/image.png',
    '#ffffff; color:red',
    '#ffffff\n',
    false,
    7,
    {},
    [],
  ]) {
    assert.throws(() => normalizeCard({ ...page, page_colors: { light: { background } } }));
  }
});

test('public HTML bootstraps forced appearance safely and leaves redirect pages untouched', () => {
  const card = normalizeCard({ ...page, page_theme: 'dark', page_colors: colors });
  const html = renderCard(card, 'https://linkbed.me/page');
  assert.match(html, /<html lang="en" data-theme="dark">/);
  const payload = JSON.parse(
    html.match(/<script id="page-appearance" type="application\/json">(.+?)<\/script>/s)[1],
  );
  assert.deepEqual(payload, { theme: 'dark', colors: normalizedColors });
  assert.doesNotMatch(html, /<style|style=/);
  const automatic = renderCard(
    normalizeCard({ ...page, page_colors: colors }),
    'https://linkbed.me/page',
  );
  assert.match(automatic, /"theme":"auto"/);
  assert.doesNotMatch(automatic, /<html[^>]+data-theme/);
  assert.match(
    renderCard(normalizeCard({ ...page, page_color_scheme: 'light' }), 'https://linkbed.me/page'),
    /"colors":\{\},"colorScheme":"light"/,
  );
  assert.doesNotMatch(
    renderCard(normalizeCard(page), 'https://linkbed.me/page'),
    /id="page-appearance"/,
  );
  const redirect = renderCard(
    normalizeCard({ ...card, url: 'https://example.com/' }),
    'https://linkbed.me/page',
  );
  assert.match(redirect, /src="\/redirect.mjs"/);
  assert.doesNotMatch(redirect, /id="page-appearance"|<html[^>]+data-theme/);
  const unsafe = renderCard(
    { ...card, page_colors: { dark: { background: '</script><script>alert(1)</script>' } } },
    'https://linkbed.me/page',
  );
  assert.doesNotMatch(unsafe, /<script>alert/);
  assert.match(unsafe, /\\u003c\/script>/);
});

const publicModule = readFileSync(new URL('../public/card.mjs', import.meta.url), 'utf8').replace(
  /^import \{ [^}]+ \} from '\.\/(?:components|model)\.mjs';\s*/gm,
  '',
);

function publicPage(appearance, savedTheme, systemDark = false) {
  const style = () => ({
    values: {},
    setProperty(name, value) {
      this.values[name] = value;
    },
  });
  const root = { dataset: {}, style: style() };
  const body = { dataset: {} };
  const preview = {
    dataset: {},
    style: style(),
    children: [],
    append(node) {
      this.children.push(node);
    },
  };
  const card = { parentElement: preview };
  const second = { type: 17, components: [{ type: 10, content: 'second card' }] };
  const scripts = {
    'discord:component-embed': { textContent: JSON.stringify({ component: second }) },
    'page-cards': { textContent: JSON.stringify([component, second]) },
    ...(appearance ? { 'page-appearance': { textContent: JSON.stringify(appearance) } } : {}),
  };
  const rendered = [];
  runInNewContext(publicModule, {
    PAGE_COLORS,
    document: {
      documentElement: root,
      body,
      querySelector: (selector) => (selector === '#public-card' ? card : null),
      getElementById: (id) => scripts[id] || null,
      createElement: () => ({ setAttribute() {} }),
    },
    localStorage: {
      getItem: () => savedTheme,
      setItem() {
        throw new Error('visitor preference must remain unchanged');
      },
    },
    matchMedia: () => ({ matches: systemDark }),
    renderComponent: (_node, value) => rendered.push(JSON.parse(JSON.stringify(value))),
  });
  return { root, body, preview, rendered, second };
}

test('public entry forces selected theme, applies active palette to page/card/chrome and preserves page order', () => {
  const state = publicPage({ theme: 'light', colors: normalizedColors }, 'dark', true);
  assert.equal(state.root.dataset.theme, 'light');
  assert.equal(state.preview.dataset.previewTheme, 'light');
  assert.equal(state.root.style.values['--page-bg'], '#abcdef');
  assert.equal(state.root.style.values['--ink'], '#112233');
  assert.equal(state.root.style.values['--accent'], '#445566');
  assert.equal(state.preview.style.values['--discord-bg'], undefined);
  assert.equal(state.preview.style.values['--discord-card'], '#fedcba');
  assert.equal(state.preview.style.values['--discord-ink'], '#112233');
  assert.equal(state.preview.style.values['--discord-text'], '#112233');
  assert.equal(state.preview.style.values['--discord-link'], '#445566');
  assert.equal(state.preview.style.values['--discord-button'], '#aabbcc');
  assert.equal(state.preview.style.values['--discord-button-text'], '#ddeeff');
  assert.equal(
    state.preview.style.values['--discord-button-hover'],
    'color-mix(in srgb, #aabbcc 85%, #ddeeff)',
  );
  assert.equal(state.body.dataset.customBackground, undefined);
  assert.equal(
    state.preview.style.values['--discord-border'],
    'color-mix(in srgb, #112233 25%, #fedcba)',
  );
  assert.equal(state.root.style.values['--line'], state.preview.style.values['--discord-border']);
  assert.equal(state.root.style.values['--muted'], state.preview.style.values['--discord-muted']);
  assert.deepEqual(state.rendered, [component, state.second]);
  const preferred = publicPage(
    { theme: 'auto', colors: { light: { background: '#ffffff' }, dark: { text: '#eeeeee' } } },
    'dark',
  );
  assert.equal(preferred.root.dataset.theme, 'dark');
  assert.equal(preferred.root.style.values['--ink'], '#eeeeee');
  assert.equal(preferred.body.dataset.customBackground, undefined);
  assert.equal(preferred.root.style.values['--page-bg'], undefined);
  assert.equal(publicPage(null, null, true).root.dataset.theme, 'dark');
  assert.equal(publicPage(null, 'invalid', false).root.dataset.theme, 'light');
});

test('one color scheme uses identical full palettes in both themes and derives borders for card-only overrides', () => {
  for (const colorScheme of ['light', 'dark']) {
    const appearance = { colorScheme, colors: { [colorScheme]: { card: '#123456' } } };
    const light = publicPage({ ...appearance, theme: 'light' }, 'dark');
    const dark = publicPage({ ...appearance, theme: 'dark' }, 'light');
    assert.equal(light.root.dataset.theme, 'light');
    assert.equal(dark.root.dataset.theme, 'dark');
    assert.deepEqual(light.root.style.values, dark.root.style.values);
    assert.deepEqual(light.preview.style.values, dark.preview.style.values);
    assert.equal(light.root.style.values['--page-bg'], PAGE_COLORS[colorScheme].background);
    assert.equal(light.preview.style.values['--discord-card'], '#123456');
    assert.equal(light.preview.style.values['--discord-button'], PAGE_COLORS[colorScheme].button);
    assert.equal(
      light.preview.style.values['--discord-button-text'],
      PAGE_COLORS[colorScheme].button_text,
    );
    assert.equal(
      light.preview.style.values['--discord-border'],
      `color-mix(in srgb, ${PAGE_COLORS[colorScheme].text} 25%, #123456)`,
    );
    const defaults = publicPage({ colorScheme }, null);
    assert.equal(defaults.root.style.values['--page-bg'], PAGE_COLORS[colorScheme].background);
    assert.equal(defaults.preview.style.values['--discord-card'], PAGE_COLORS[colorScheme].card);
    const independent = publicPage({ theme: colorScheme, colors: appearance.colors }, null);
    assert.equal(
      independent.preview.style.values['--discord-border'],
      light.preview.style.values['--discord-border'],
    );
  }
});

test('API preserves appearance with destinations and clears optional appearance without changing framing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'linkbed-appearance-'));
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
      slug: 'appearance',
      page_theme: 'light',
      page_color_scheme: 'dark',
      page_colors: colors,
    };
    assert.equal((await request('/api/cards', 'POST', saved)).status, 201);
    let stored = await (await request('/api/cards/appearance')).json();
    assert.equal(stored.page_theme, 'light');
    assert.equal(stored.page_color_scheme, 'dark');
    assert.deepEqual(stored.page_colors, normalizedColors);
    const published = await request('/appearance');
    assert.equal(published.headers.get('x-frame-options'), 'DENY');
    assert.match(published.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await published.text(), /"colorScheme":"dark"/);
    assert.deepEqual(await (await request('/api/embeds/appearance')).json(), { component });
    assert.equal(
      (await request('/api/cards/appearance', 'PUT', { ...saved, url: 'https://example.com/' }))
        .status,
      200,
    );
    stored = await (await request('/api/cards/appearance')).json();
    assert.equal(stored.page_color_scheme, 'dark');
    assert.deepEqual(stored.page_colors, normalizedColors);
    assert.doesNotMatch(
      await (await request('/appearance')).text(),
      /id="page-appearance"|<html[^>]+data-theme/,
    );
    assert.equal(
      (
        await request('/api/cards/appearance', 'PUT', {
          ...saved,
          page_colors: { light: { background: 'url(https://example.com/)' } },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request('/api/cards/appearance', 'PUT', {
          ...saved,
          page_theme: 'auto',
          page_color_scheme: 'auto',
          page_colors: {},
        })
      ).status,
      200,
    );
    stored = await (await request('/api/cards/appearance')).json();
    assert.equal('page_theme' in stored, false);
    assert.equal('page_color_scheme' in stored, false);
    assert.equal('page_colors' in stored, false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
