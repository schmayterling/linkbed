import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BYTES,
  ValidationError,
  normalizeComponent,
  normalizeCard,
  buildEmbed,
  componentStats,
  componentImages,
  componentUrls,
  embedJson,
  payloadBytes,
  httpsUrl,
  publicHttpUrl,
  normalizeSlug,
  normalizeColor,
  thumbnailUrl,
  formatUrl,
  formatColor,
  formatSlug,
} from '../public/model.mts';
import type {
  ActionRowComponent,
  ButtonComponent,
  ContainerComponent,
  Emoji,
  GalleryComponent,
  SectionComponent,
  SeparatorComponent,
  TextComponent,
  ThumbnailComponent,
} from '../public/model.mts';

type ContainerWith<Children extends ContainerComponent['components']> = ContainerComponent & {
  components: Children;
};

const text = (content = 'hello'): TextComponent => ({ type: 10, content });
const root = <Children extends unknown[]>(
  ...components: Children
): {
  type: 17;
  components: Children;
} => ({ type: 17, components });
const button = (extra: Record<string, unknown> = {}) =>
  ({
    type: 2,
    style: 5,
    label: 'visit',
    url: 'https://example.com',
    ...extra,
  }) satisfies Pick<ButtonComponent, 'type' | 'style' | 'label' | 'url'>;
const row = <Children extends unknown[]>(
  ...components: Children
): {
  type: 1;
  components: Children;
} => ({ type: 1, components });
const item = (url = 'https://example.com/image.png') => ({ media: { url } });
const thumbnail = (extra: Record<string, unknown> = {}) => ({ type: 11, ...item(), ...extra });
const section = (accessory: unknown = thumbnail(), ...components: unknown[]) => ({
  type: 9,
  components: components.length ? components : [text()],
  accessory,
});
const gallery = (count = 1) => ({ type: 12, items: Array.from({ length: count }, () => item()) });
const card = (extra: Record<string, unknown> = {}) => ({
  title: 'hello',
  url: 'https://example.com',
  ...extra,
});
const invalid = (callback: () => unknown) =>
  assert.throws(callback, (error) => error instanceof ValidationError && error.status === 400);

test('all eight node types normalize, preserve static fields and collect URLs', () => {
  const input = {
    ...root(
      text(' # heading\nbody '),
      row(button({ disabled: false })),
      section(thumbnail({ description: null, spoiler: true })),
      section(button({ label: 'side', url: 'http://example.org/side' })),
      {
        ...gallery(),
        items: [{ ...item('http://example.org/video.mp4'), description: 'video', spoiler: false }],
      },
      { type: 14, divider: false, spacing: 2 },
    ),
    id: 4294967295,
    accent_color: null,
    spoiler: true,
  };
  // Normalization preserves the fixture's six child positions and its thumbnail accessory.
  const normalized = normalizeComponent(input) as ContainerWith<
    [
      TextComponent,
      ActionRowComponent,
      SectionComponent & { accessory: ThumbnailComponent },
      SectionComponent,
      GalleryComponent,
      SeparatorComponent,
    ]
  >;
  assert.deepEqual(input.components[0], text(' # heading\nbody '));
  assert.equal(normalized.components[0].content, ' # heading\nbody ');
  assert.equal(normalized.accent_color, null);
  assert.equal(normalized.components[1].components[0].url, 'https://example.com/');
  assert.deepEqual(componentStats(normalized), { components: 12, media: 1 });
  assert.deepEqual(componentImages(normalized), [
    'https://example.com/image.png',
    'http://example.org/video.mp4',
  ]);
  assert.deepEqual(componentUrls(normalized), [
    'https://example.com/',
    'https://example.com/image.png',
    'http://example.org/side',
    'http://example.org/video.mp4',
  ]);
  assert.equal(normalized.components[2].accessory.spoiler, true);
  assert.equal(normalized.components[4].items[0].spoiler, false);
});

test('root and nested child positions reject unsupported types', () => {
  for (const input of [
    text(),
    root(),
    root(root(text())),
    root(button()),
    root(thumbnail()),
    root(row(text())),
    root(row(thumbnail())),
    root(row()),
    root(row(...Array.from({ length: 6 }, () => button()))),
    root({ type: 9, components: [text()] }),
    root(section({ type: 14 })),
    root(section(thumbnail(), row(button()))),
    root(section(thumbnail(), ...Array.from({ length: 4 }, () => text()))),
    root({ type: 9, components: [], accessory: thumbnail() }),
    root({ type: 13 }),
    root({ type: 'constructor' }),
    root({ type: '10', content: 'no' }),
    null,
    [],
    'invalid',
  ])
    invalid(() => normalizeComponent(input));
});

test('unknown fields reject at every nested object boundary', () => {
  const candidates = [
    { ...root(text()), custom_id: 'no' },
    root({ ...text(), extra: true }),
    root({ ...row(button()), extra: true }),
    root(row(button({ custom_id: 'no' }))),
    root(section({ ...thumbnail(), extra: true })),
    root({ ...section(), extra: true }),
    root({ ...gallery(), extra: true }),
    root({ type: 14, extra: true }),
    root({ type: 12, items: [{ ...item(), extra: true }] }),
    root({
      type: 12,
      items: [{ media: { url: 'https://example.com/i', content_type: 'image/png' } }],
    }),
    root(
      section({
        type: 11,
        media: { url: 'https://example.com/i', proxy_url: 'https://example.org/i' },
      }),
    ),
    root(row(button({ emoji: { name: '🔥', extra: true } }))),
  ];
  candidates.forEach((input) => invalid(() => normalizeComponent(input)));
});

test('40 component cap includes root, row buttons and section accessories', () => {
  const separators = Array.from({ length: 36 }, () => ({ type: 14 }));
  const accepted = root(...separators, section());
  assert.equal(componentStats(normalizeComponent(accepted)).components, 40);
  invalid(() => normalizeComponent(root(...separators, { type: 14 }, section())));
  const buttons = root(
    ...Array.from({ length: 6 }, () => row(...Array.from({ length: 5 }, () => button()))),
  );
  assert.equal(componentStats(normalizeComponent(buttons)).components, 37);
  invalid(() => normalizeComponent(root(...buttons.components, row(button(), button(), button()))));
});

test('gallery budget spans all galleries and excludes thumbnails', () => {
  const accepted = normalizeComponent(root(section(), gallery(5), gallery(5)));
  assert.deepEqual(componentStats(accepted), { components: 6, media: 10 });
  assert.equal(componentImages(accepted).length, 11);
  invalid(() => normalizeComponent(root(gallery(6), gallery(5))));
  invalid(() => normalizeComponent(root(gallery(0))));
  invalid(() => normalizeComponent(root(gallery(11))));
});

test('component ids accept unsigned 32-bit bounds and only repeat zero', () => {
  normalizeComponent({ ...root({ ...text(), id: 4294967295 }, { ...text(), id: 0 }), id: 0 });
  for (const id of [-1, 4294967296, 1.5, '1', null, false]) {
    invalid(() => normalizeComponent({ ...root(text()), id }));
  }
  invalid(() => normalizeComponent({ ...root({ ...text(), id: 8 }), id: 8 }));
  invalid(() => normalizeComponent(root(section({ ...thumbnail(), id: 9 }, { ...text(), id: 9 }))));
});

test('link buttons validate style, label, emoji and flags', () => {
  for (const emoji of [
    { name: '🔥', id: null },
    { id: '123456789012345678', name: null, animated: true },
    { id: '18446744073709551615' },
  ]) {
    const emojiButton: { label?: string } = button({ emoji });
    delete emojiButton.label;
    assert.deepEqual(
      // The root fixture contains only an action row.
      (normalizeComponent(root(row(emojiButton))).components[0] as ActionRowComponent).components[0]
        .emoji,
      emoji,
    );
  }
  for (const extra of [
    { style: 1 },
    { style: '5' },
    { label: '' },
    { label: 'a'.repeat(81) },
    { label: null },
    { disabled: 1 },
    { emoji: {} },
    { emoji: { id: '0' } },
    { emoji: { id: '18446744073709551616' } },
    { emoji: { id: 123 } },
    { emoji: { id: '12x' } },
    { emoji: { id: null, name: null } },
    { emoji: { name: '🔥', animated: 'true' } },
  ])
    invalid(() => normalizeComponent(root(row(button(extra)))));
  invalid(() => normalizeComponent(root(row({ type: 2, style: 5, url: 'https://example.com' }))));
  normalizeComponent(root(row(button({ label: 'a'.repeat(80) }))));
});

test('emoji presentation normalization fixes Discord rejects without changing text or required selectors', () => {
  const emojis = ['⭐️', '🦋️', '❤️', '1️⃣', '👩‍💻', '🏳️‍🌈', '👍🏽'];
  const expected = ['⭐', '🦋', '❤️', '1️⃣', '👩‍💻', '🏳️‍🌈', '👍🏽'];
  const component = root(
    text('keep text ⭐️ and </script> unchanged'),
    row(...emojis.slice(0, 5).map((name) => button({ emoji: { name, id: null } }))),
    row(
      ...emojis.slice(5).map((name) => button({ emoji: { name, id: null } })),
      button({ emoji: { id: '123456789012345678', name: 'custom', animated: true } }),
    ),
  );
  type EmojiButton = ButtonComponent & { emoji: Emoji };
  type EmojiRow = ActionRowComponent & { components: EmojiButton[] };
  type EmojiContainer = ContainerWith<[TextComponent, EmojiRow, EmojiRow]>;
  const names = (node: EmojiContainer) =>
    // The only children after the initial text are the two emoji rows.
    (node.components.slice(1) as EmojiRow[])
      .flatMap((row) => row.components)
      .map((button) => button.emoji.name);
  // Normalization preserves the text followed by both emoji rows.
  const normalized = normalizeComponent(component) as EmojiContainer;
  assert.deepEqual(names(normalized), [...expected, 'custom']);
  assert.equal(normalized.components[0].content, component.components[0].content);
  // Stored cards and unfinished drafts serialize without requiring a rewrite.
  const { component: serialized }: { component: EmojiContainer } = JSON.parse(
    embedJson({ component }),
  );
  assert.deepEqual(names(serialized), [...expected, 'custom']);
  assert.equal(serialized.components[0].content, component.components[0].content);
  // Every button in the first row was given an emoji in the fixture.
  assert.equal((component.components[1].components[0] as EmojiButton).emoji.name, '⭐️');
  assert.equal(payloadBytes({ component }), Buffer.byteLength(embedJson({ component })));
});

test('url schemes, encoded lengths, credentials and ports are validated', () => {
  assert.equal(publicHttpUrl('http://EXAMPLE.com:80/a'), 'http://example.com/a');
  assert.equal(httpsUrl('https://EXAMPLE.com:443/a'), 'https://example.com/a');
  invalid(() => httpsUrl('http://example.com'));
  for (const url of [
    'javascript:alert(1)',
    'data:image/png;base64,abc',
    'ftp://example.com',
    'https://user:pass@example.com',
    'https://example.com:444/',
    'http://example.com:443/',
    'https://localhost',
    'https://foo.internal',
    'https://foo.local/',
  ])
    invalid(() => normalizeComponent(root({ type: 12, items: [item(url)] })));
  invalid(() =>
    normalizeComponent(root(row(button({ url: 'https://example.com/' + '界'.repeat(60) })))),
  );
  invalid(() =>
    normalizeComponent(
      root(gallery(), row(button({ url: 'https://example.com/' + 'x'.repeat(513) }))),
    ),
  );
  invalid(() =>
    normalizeComponent(
      root({ type: 12, items: [item('https://example.com/' + 'x'.repeat(2048))] }),
    ),
  );
});

test('thumbnail videos, descriptions and optional booleans reject invalid input', () => {
  for (const url of ['https://example.com/video.MP4?image=1', 'https://example.com/video%2ewebm']) {
    invalid(() => normalizeComponent(root(section({ type: 11, ...item(url) }))));
    normalizeComponent(root({ type: 12, items: [item(url)] }));
  }
  normalizeComponent(root(section(thumbnail({ description: 'a'.repeat(1024), spoiler: false }))));
  for (const extra of [
    { description: 1 },
    { description: 'a'.repeat(1025) },
    { spoiler: null },
    { spoiler: 'false' },
  ]) {
    invalid(() => normalizeComponent(root(section(thumbnail(extra)))));
    invalid(() => normalizeComponent(root({ type: 12, items: [{ ...item(), ...extra }] })));
  }
  for (const extra of [
    { accent_color: -1 },
    { accent_color: 16777216 },
    { accent_color: 1.5 },
    { accent_color: '#ffffff' },
    { spoiler: 1 },
  ]) {
    invalid(() => normalizeComponent({ ...root(text()), ...extra }));
  }
  normalizeComponent({ ...root(text()), accent_color: 16777215, spoiler: false });
  for (const extra of [{ spacing: 0 }, { spacing: 3 }, { spacing: '1' }, { divider: null }]) {
    invalid(() => normalizeComponent(root({ type: 14, ...extra })));
  }
});

test('actual escaped UTF-8 payload permits exactly 3000 bytes and rejects one more', () => {
  const emptySize = payloadBytes({ component: root(text('')) });
  const exact = root(text('x'.repeat(MAX_BYTES - emptySize)));
  assert.equal(payloadBytes({ component: normalizeComponent(exact) }), MAX_BYTES);
  invalid(() => normalizeComponent(root(text(exact.components[0].content + 'x'))));
  for (const content of ['界'.repeat(1000), '<'.repeat(500)]) {
    assert.ok(content.length < MAX_BYTES);
    invalid(() => normalizeComponent(root(text(content))));
  }
  const safe = normalizeCard(card({ component: root(text('</script>🔥')) }));
  assert.equal(payloadBytes(safe), Buffer.byteLength(embedJson(safe)));
  assert.ok(!embedJson(safe).includes('<'));
  const payload: { component: { components: { content: unknown }[] } } = JSON.parse(
    embedJson(safe),
  );
  assert.equal(payload.component.components[0].content, '</script>🔥');
});

test('component card is authoritative and serialization remains usable for drafts', () => {
  const component = root(
    ...Array.from({ length: 2 }, () => row(...Array.from({ length: 4 }, () => button()))),
    {
      type: 12,
      items: [item('http://example.com/image.png')],
    },
  );
  const normalized = normalizeCard(
    card({
      component,
      images: 'ignored',
      buttons: 'ignored',
      description: 'd'.repeat(4096),
      color: null,
    }),
  );
  assert.deepEqual(normalized.buttons, []);
  assert.deepEqual(normalized.images, ['http://example.com/image.png']);
  assert.equal(normalized.color, null);
  assert.deepEqual(buildEmbed(normalized), { component: normalized.component });
  invalid(() => normalizeCard(card({ component: null })));
  invalid(() => normalizeCard(card({ component, title: 'x'.repeat(257) })));
  invalid(() => normalizeCard(card({ component, description: 'x'.repeat(4097) })));
  const draft = { component: root(text('x'.repeat(4000))) };
  assert.ok(payloadBytes(draft) > MAX_BYTES);
  assert.equal(buildEmbed(draft).component, draft.component);
  assert.ok(embedJson(draft).length > MAX_BYTES);
  assert.deepEqual(
    componentStats({ type: 17, components: [null, { type: 9, accessory: { type: 11 } }] }),
    { components: 3, media: 0 },
  );
});

test('field formatting preserves URL restrictions and normalizes colors and custom links', () => {
  assert.equal(formatUrl(' github.com/schmayterling.png '), 'https://github.com/schmayterling.png');
  assert.equal(formatUrl('//example.com/path'), 'https://example.com/path');
  assert.equal(formatUrl('http://EXAMPLE.com:80/a'), 'http://example.com/a');
  assert.equal(formatUrl('not a url'), 'not a url');
  invalid(() => httpsUrl(formatUrl('http://example.com')));
  invalid(() => publicHttpUrl(formatUrl('example.com:444/path')));
  invalid(() => publicHttpUrl(formatUrl('user:pass@example.com')));
  assert.equal(formatColor(' AbC '), '#aabbcc');
  assert.equal(formatColor('AABBCC'), '#aabbcc');
  invalid(() => normalizeColor(formatColor('red')));
  assert.equal(normalizeColor(formatColor('123')), '#112233');
  assert.equal(formatSlug(' Café / Card '), 'cafe-card');
  assert.equal(normalizeSlug(formatSlug('MY CARD')), 'my-card');
  for (const value of ['', 'api', 'healthz', 'bad--link', 'a'.repeat(61)])
    invalid(() => normalizeSlug(value));
  invalid(() => thumbnailUrl('https://example.com/video%2Emp4'));
});

test('legacy cards retain simple payload, default arrays, metadata bounds and byte validation', () => {
  const normalized = normalizeCard(
    card({
      title: 'hello *world*',
      description: 'body',
      color: '#ABCDEF',
      buttons: [{ label: 'go', url: 'https://example.com/go' }],
      images: ['https://example.com/i.png'],
    }),
  );
  assert.equal(normalized.color, '#abcdef');
  assert.equal('component' in normalized, false);
  // This legacy fixture generates text, gallery, separator, and action-row children.
  const component = buildEmbed(normalized).component as ContainerWith<
    [TextComponent, GalleryComponent, SeparatorComponent, ActionRowComponent]
  >;
  assert.equal(component.accent_color, 0xabcdef);
  assert.equal(component.components[0].content, '## hello \\*world\\*\nbody');
  assert.deepEqual(
    component.components.map((node) => node.type),
    [10, 12, 14, 1],
  );
  assert.equal(component.components[3].components[0].style, 5);
  assert.deepEqual(normalizeCard(card()).buttons, []);
  assert.deepEqual(normalizeCard(card()).images, []);
  assert.equal(
    // A normalized legacy card always has a generated Discord container.
    (buildEmbed(normalizeCard(card({ color: null }))).component as ContainerComponent).accent_color,
    null,
  );
  normalizeCard(card({ title: 't'.repeat(256), url: 'https://example.com/' + 'p'.repeat(1000) }));
  for (const extra of [
    { title: '' },
    { title: 't'.repeat(257) },
    { description: '界'.repeat(1000) },
    { url: 'http://example.com' },
    { color: [] },
    { buttons: null },
    { images: null },
    { buttons: Array.from({ length: 6 }, () => ({ label: 'go', url: 'https://example.com' })) },
    { images: Array(11).fill('https://example.com/i.png') },
  ])
    invalid(() => normalizeCard(card(extra)));
});
