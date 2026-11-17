import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCardJson, messageJson } from '../public/interchange.mjs';
import { MAX_CARDS } from '../public/model.mjs';

const component = {
  type: 17,
  accent_color: 0xabcdef,
  spoiler: true,
  components: [
    { type: 10, content: '## hello\n<@123456789>' },
    { type: 1, components: [{ type: 2, style: 5, label: 'open', url: 'https://example.com/' }] },
  ],
};

test('message json is pasteable Discord V2 and round-trips without identity or tokens', () => {
  const value = {
    title: 'ignored metadata',
    url: 'https://example.com',
    component,
    token: 'private',
  };
  const message = JSON.parse(messageJson(value));
  assert.equal(message.flags, 32768);
  assert.deepEqual(message.components, [component]);
  assert.deepEqual(message.allowed_mentions, { parse: [] });
  assert.deepEqual(Object.keys(message), ['flags', 'components', 'allowed_mentions']);
  assert.deepEqual(importCardJson(messageJson(value)), { component });
});

test('imports native, raw message, link embed and one-message Discohook backup shapes', () => {
  const message = JSON.parse(messageJson({ component }));
  for (const data of [
    component,
    { component },
    message,
    { embeds: [{ type: 'components', components: [component] }] },
    { version: 'd2', messages: [{ data: message }], targets: [] },
    { version: 8, backups: [{ messages: [{ data: message }], targets: [] }] },
  ])
    assert.deepEqual(importCardJson(JSON.stringify(data)), { component });
});

test('multicard native and Discord message roots round-trip without flattening card styles', () => {
  const extra = {
    type: 17,
    accent_color: null,
    spoiler: false,
    components: [{ type: 10, content: 'second card' }],
  };
  const card = { component, additional_cards: [extra] };
  assert.deepEqual(JSON.parse(messageJson(card)).components, [component]);
  const message = { flags: 32768, components: [component, extra] };
  for (const data of [
    card,
    message,
    { embeds: [{ type: 'components', components: [component, extra] }] },
    { messages: [{ data: message }] },
  ]) {
    assert.deepEqual(importCardJson(JSON.stringify(data)), card);
  }
  assert.deepEqual(importCardJson({ component, additional_cards: [] }), { component });
  assert.equal(
    JSON.parse(messageJson({ component, additional_cards: Array(MAX_CARDS - 1).fill(extra) }))
      .components.length,
    1,
  );
  for (const data of [
    { component, additional_cards: Array(MAX_CARDS - 1).fill(extra) },
    { components: [component, ...Array(MAX_CARDS - 1).fill(extra)] },
  ]) {
    assert.equal(importCardJson(data).additional_cards.length, MAX_CARDS - 1);
  }
  assert.throws(() =>
    importCardJson({ component, additional_cards: Array(MAX_CARDS).fill(extra) }),
  );
  assert.throws(() =>
    importCardJson({
      component,
      additional_cards: [
        component,
        { ...extra, components: [{ type: 10, content: 'x'.repeat(4000) }] },
      ],
    }),
  );
});

test('discord export excludes site-only cards regardless of their combined size', () => {
  const first = { type: 17, components: Array.from({ length: 19 }, () => ({ type: 14 })) };
  const second = structuredClone(first);
  assert.equal(
    JSON.parse(messageJson({ component: first, additional_cards: [second] })).components.length,
    1,
  );
  second.components.push({ type: 14 });
  assert.deepEqual(
    JSON.parse(messageJson({ component: first, additional_cards: [second] })).components,
    [first],
  );
  assert.deepEqual(importCardJson({ component: first, additional_cards: [second] }), {
    component: first,
    additional_cards: [second],
  });
});

test('classic embed import maps text, fields, media, footer and timestamp to components', () => {
  const result = importCardJson({
    embeds: [
      {
        title: 'hello *world*',
        url: 'https://example.com/a(b)',
        color: 0xff0000,
        author: { name: 'author' },
        description: '**description**',
        fields: [{ name: 'name', value: 'value', inline: true }],
        thumbnail: { url: 'https://example.com/thumb.png' },
        image: { url: 'https://example.com/image.png' },
        footer: { text: 'footer' },
        timestamp: '2026-11-17T00:00:00Z',
      },
    ],
    components: [
      { type: 1, components: [{ type: 2, style: 5, label: 'go', url: 'https://example.com' }] },
    ],
  });
  assert.equal(result.title, 'hello *world*');
  assert.equal(result.url, 'https://example.com/a(b)');
  assert.equal(result.component.accent_color, 0xff0000);
  assert.equal(result.component.components[0].type, 9);
  const texts = result.component.components
    .filter((node) => node.type === 10)
    .map((node) => node.content)
    .join('\n');
  assert.match(texts, /hello \\\*world\\\*/);
  assert.match(texts, /https:\/\/example.com\/a%28b%29/);
  assert.match(texts, /\*\*name\*\*\nvalue/);
  assert.match(texts, /-# footer/);
  assert.match(texts, /<t:\d+:f>/);
  assert.ok(result.component.components.some((node) => node.type === 12));
  assert.equal(result.component.components.at(-1).type, 1);
});

test('unsupported or oversized imports fail before replacing a draft', () => {
  const message = { flags: 32768, components: [component] };
  for (const value of [
    null,
    [],
    { backups: [null] },
    { messages: [] },
    { messages: [{ data: message }, { data: message }] },
    { backups: [{}, {}] },
    { ...message, content: 'extra' },
    { components: [component, component], content: 'extra' },
    { components: [component, { type: 14 }] },
    { components: [component], embeds: [{}] },
    { component, additional_cards: null },
    { component, additional_cards: [{ type: 10, content: 'not a root' }] },
    { components: Array(MAX_CARDS + 1).fill(component) },
    { embeds: [{ title: 'one' }, { title: 'two' }] },
    { content: 'hi', attachments: [{ id: '123' }] },
    { content: 'hi', components: [{ type: 3 }] },
    { embeds: [{ title: 'x', url: 'javascript:alert(1)' }] },
    { component: { type: 17, components: [{ type: 10, content: 'x'.repeat(4000) }] } },
  ])
    assert.throws(() => importCardJson(value));
  assert.throws(() => importCardJson('{invalid json'));
});
