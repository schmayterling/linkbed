import MarkdownIt from './vendor/markdown-it.mjs';
import {
  publicHttpUrl,
  text as validateText,
  normalizeEmoji,
  thumbnailUrl,
  formatUrl,
  componentStats,
  isBadgeCase,
  MAX_BADGES,
} from './model.mjs';
import { icon } from './icons.mjs';
import Sortable from './vendor/sortable.mjs';
import { openEmojiPicker, autocompleteEmoji } from './emoji-picker.mjs';

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true }).disable([
  'image',
  'table',
]);
// Stop the normal text rule at a spoiler marker so the Discord rule can read it.
const textRule = markdown.inline.ruler.getRules('')[0];
markdown.inline.ruler.at('text', (state, silent) => {
  const marker = state.src.indexOf('||', state.pos);
  if (marker < 0 || marker >= state.posMax) return textRule(state, silent);
  if (marker === state.pos) return false;
  const max = state.posMax;
  state.posMax = marker;
  const result = textRule(state, silent);
  state.posMax = max;
  return result;
});
// Discord's underline and spoilers differ from CommonMark's emphasis rules.
markdown.inline.ruler.before('text', 'discord_format', (state, silent) => {
  const marker = state.src.slice(state.pos, state.pos + 2);
  if (marker !== '__' && marker !== '||') return false;
  let end = state.src.indexOf(marker, state.pos + 2);
  while (end > 0 && state.src[end - 1] === '\\') end = state.src.indexOf(marker, end + 2);
  if (end <= state.pos + 2) return false;
  if (!silent) {
    const token = state.push(marker === '__' ? 'discord_underline' : 'discord_spoiler', '', 0);
    token.content = state.src.slice(state.pos + 2, end);
  }
  state.pos = end + 2;
  return true;
});
markdown.renderer.rules.discord_underline = (tokens, index) =>
  '<u>' + markdown.renderInline(tokens[index].content) + '</u>';
markdown.renderer.rules.discord_spoiler = (tokens, index) =>
  '<button type="button" class="text-spoiler" aria-label="reveal spoiler">' +
  markdown.renderInline(tokens[index].content) +
  '</button>';
markdown.validateLink = (url) => {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, index, options);
};
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const copy = (value) => structuredClone(value);

export function textPreview(content) {
  const div = el('div', undefined, 'component-text');
  // markdown-it has HTML disabled; only the parser's own markup reaches innerHTML.
  div.innerHTML = markdown.render(content || '');
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    if (!walker.currentNode.parentElement.closest('code, pre, a')) nodes.push(walker.currentNode);
  }
  for (const node of nodes) {
    const parts = node.textContent.split(
      /(<t:\d+(?::[tTdDfFRsS])?>|<a?:\w+:\d+>|<(?:@!?|@&|#)\d+>)/g,
    );
    if (parts.length < 2) continue;
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      let item;
      if (/^<t:\d+(?::[tTdDfFRsS])?>$/.test(part)) {
        const [, seconds, format] = part.match(/^<t:(\d+)(?::([tTdDfFRsS]))?>$/);
        const style = format || 'f';
        const date = new Date(Number(seconds) * 1000);
        if (!Number.isFinite(date.getTime())) {
          fragment.append(document.createTextNode(part));
          continue;
        }
        let value = date.toLocaleString([], {
          dateStyle: style === 'F' ? 'full' : style === 's' || style === 'S' ? 'short' : 'long',
          timeStyle: style === 'S' ? 'medium' : 'short',
        });
        if (style === 't' || style === 'T')
          value = date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            ...(style === 'T' ? { second: '2-digit' } : {}),
          });
        if (style === 'd' || style === 'D')
          value = date.toLocaleDateString([], style === 'D' ? { dateStyle: 'long' } : {});
        if (style === 'R') {
          const seconds = (date - Date.now()) / 1000;
          const [unit, size] = [
            [31536000, 'year'],
            [2592000, 'month'],
            [604800, 'week'],
            [86400, 'day'],
            [3600, 'hour'],
            [60, 'minute'],
            [1, 'second'],
          ].find(([duration]) => Math.abs(seconds) >= duration) || [1, 'second'];
          value = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
            Math.round(seconds / unit),
            size,
          );
        }
        item = el('time', value, 'discord-time');
        item.dateTime = date.toISOString();
      } else if (/^<a?:\w+:\d+>$/.test(part)) {
        const [, animated, name, id] = part.match(/^<(a?):(\w+):(\d+)>$/);
        item = el('img', undefined, 'discord-emoji');
        item.alt = ':' + name + ':';
        item.src =
          'https://cdn.discordapp.com/emojis/' + id + (animated ? '.gif' : '.png') + '?size=32';
      } else if (/^<(?:@!?|@&|#)\d+>$/.test(part)) {
        item = el(
          'span',
          (part.startsWith('<#') ? '#channel-' : '@') + part.replace(/\D/g, ''),
          'discord-mention',
        );
      }
      fragment.append(item || document.createTextNode(part));
    }
    node.replaceWith(fragment);
  }
  div.querySelectorAll('.text-spoiler').forEach((button) => {
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () =>
      button.setAttribute('aria-pressed', String(button.classList.toggle('revealed'))),
    );
  });
  return div;
}

function media(item, thumbnail = false) {
  const box = el('div', undefined, thumbnail ? 'component-thumbnail' : 'component-media');
  let url;
  try {
    url = publicHttpUrl(item?.media?.url || '', 'media url');
  } catch {
    box.append(el('span', 'media url', 'media-placeholder'));
    return box;
  }
  const isVideo = !thumbnail && /\.(mp4|webm|mov)(?:$|[?#])/i.test(url);
  const node = el(isVideo ? 'video' : 'img');
  node.src = url;
  node.referrerPolicy = 'no-referrer';
  if (isVideo) {
    node.controls = true;
    node.preload = 'metadata';
  } else {
    node.alt = item.description || '';
    node.loading = 'lazy';
  }
  node.addEventListener(
    'error',
    () => {
      box.replaceChildren(el('span', 'media unavailable', 'media-placeholder'));
    },
    { once: true },
  );
  box.append(node);
  if (item.spoiler) {
    node.inert = true;
    box.classList.add('media-spoiler');
    const reveal = el('button', 'spoiler', 'reveal-media');
    reveal.type = 'button';
    reveal.addEventListener('click', () => {
      box.classList.remove('media-spoiler');
      node.inert = false;
      reveal.remove();
    });
    box.append(reveal);
  }
  return box;
}

function button(component) {
  let url;
  try {
    url = publicHttpUrl(component.url || '', 'button url', 512);
  } catch {}
  const node = el(url && !component.disabled ? 'a' : 'button', undefined, 'preview-button');
  if (node.tagName === 'A') {
    node.href = url;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
  } else {
    node.type = 'button';
    node.disabled = true;
  }
  if (component.emoji?.id) {
    const image = el('img', undefined, 'discord-emoji');
    image.src =
      'https://cdn.discordapp.com/emojis/' +
      component.emoji.id +
      (component.emoji.animated ? '.gif' : '.png') +
      '?size=32';
    image.alt = component.emoji.name || '';
    node.append(image);
  } else if (component.emoji?.name)
    node.append(document.createTextNode(component.emoji.name + ' '));
  if (component.label) node.append(document.createTextNode(component.label));
  node.append(icon('external-link'));
  return node;
}

export function renderComponent(container, component) {
  container.replaceChildren();
  if (Number.isInteger(component.accent_color))
    container.style.setProperty(
      '--card-accent',
      '#' + component.accent_color.toString(16).padStart(6, '0'),
    );
  else container.style.removeProperty('--card-accent');
  container.classList.toggle('no-accent', component.accent_color == null);
  container.classList.toggle('container-spoiler', !!component.spoiler);
  container.classList.remove('revealed');
  container.classList.toggle('badge-case', isBadgeCase(component));
  if (isBadgeCase(component)) {
    if (component.title) container.append(el('h3', component.title));
    if (component.description) container.append(textPreview(component.description));
    const badges = el('div', undefined, 'badge-collection');
    for (const badge of component.badges || []) {
      const image = el('img');
      image.width = 88;
      image.height = 31;
      image.alt = badge.label || 'badge';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      try {
        image.src = publicHttpUrl(badge.image, 'badge image', 2048);
        if (badge.url) {
          const link = el('a');
          link.href = publicHttpUrl(badge.url, 'badge link', 2048);
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.append(image);
          badges.append(link);
        } else badges.append(image);
      } catch {}
    }
    container.append(badges);
  }
  function render(node) {
    if (node.type === 10) return textPreview(node.content);
    if (node.type === 1) {
      const row = el('div', undefined, 'component-row');
      row.append(...(node.components || []).map(button));
      return row;
    }
    if (node.type === 9) {
      const section = el('div', undefined, 'component-section');
      const content = el('div');
      content.append(...(node.components || []).map(render));
      section.append(content);
      if (node.accessory)
        section.append(
          node.accessory.type === 11 ? media(node.accessory, true) : button(node.accessory),
        );
      return section;
    }
    if (node.type === 12) {
      const gallery = el('div', undefined, 'preview-gallery');
      gallery.append(...(node.items || []).map((item) => media(item)));
      return gallery;
    }
    if (node.type === 14) {
      const divider = el('div', undefined, 'component-separator');
      divider.classList.toggle('no-divider', node.divider === false);
      divider.classList.toggle('large', node.spacing === 2);
      return divider;
    }
    return el('span');
  }
  container.append(...(component.components || []).map(render));
  if (component.spoiler) {
    [...container.children].forEach((child) => {
      child.inert = true;
    });
    const reveal = el('button', 'reveal card', 'reveal-container');
    reveal.type = 'button';
    reveal.addEventListener('click', () => {
      container.classList.add('revealed');
      [...container.children].forEach((child) => {
        child.inert = false;
      });
      reveal.remove();
    });
    container.append(reveal);
  }
}

function markdownToolbar(input) {
  const editor = el('div', undefined, 'markdown-editor');
  const toolbar = el('div', undefined, 'markdown-toolbar');
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', 'discord text formatting');
  const formats = [
    ['bold', 'bold', '**', '**'],
    ['italic', 'italic', '*', '*'],
    ['underline', 'underline', '__', '__'],
    ['strikethrough', 'strikethrough', '~~', '~~'],
    ['spoiler', 'eye-off', '||', '||'],
    ['inline code', 'code', '`', '`'],
    ['code block', 'code-xml', '```\n', '\n```'],
    ['link', 'link', '[', '](https://example.com)'],
  ];
  function wrap([name, , before, after]) {
    let start = input.selectionStart,
      end = input.selectionEnd;
    if (name === 'code block') {
      start = start === 0 ? 0 : input.value.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = input.value.indexOf('\n', end);
      end = lineEnd < 0 ? input.value.length : lineEnd;
    }
    let selection = input.value.slice(start, end);
    if (
      selection.startsWith(before) &&
      selection.endsWith(after) &&
      selection.length >= before.length + after.length
    ) {
      input.setRangeText(selection.slice(before.length, -after.length), start, end, 'select');
    } else if (
      start >= before.length &&
      input.value.slice(start - before.length, start) === before &&
      input.value.slice(end, end + after.length) === after
    ) {
      input.setRangeText(selection, start - before.length, end + after.length, 'select');
    } else {
      selection ||= name === 'link' ? 'link text' : 'text';
      input.setRangeText(before + selection + after, start, end, 'select');
      input.setSelectionRange(start + before.length, start + before.length + selection.length);
    }
    input.focus({ preventScroll: true });
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  for (const format of formats) {
    const button = el('button');
    button.type = 'button';
    button.title = format[0];
    button.setAttribute('aria-label', format[0]);
    button.append(icon(format[1]));
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => wrap(format));
    toolbar.append(button);
  }
  const blocks = el('select');
  blocks.setAttribute('aria-label', 'text block format');
  for (const [value, name] of [
    ['', 'text'],
    ['# ', 'heading 1'],
    ['## ', 'heading 2'],
    ['### ', 'heading 3'],
    ['> ', 'quote'],
    ['- ', 'bullet list'],
    ['1. ', 'numbered list'],
  ]) {
    const option = el('option', name);
    option.value = value;
    blocks.append(option);
  }
  blocks.addEventListener('change', () => {
    const start =
      input.selectionStart === 0 ? 0 : input.value.lastIndexOf('\n', input.selectionStart - 1) + 1;
    const lineEnd = input.value.indexOf(
      '\n',
      Math.max(input.selectionStart, input.selectionEnd - 1),
    );
    const end = lineEnd < 0 ? input.value.length : lineEnd;
    const lines = input.value.slice(start, end).split('\n');
    const value = lines
      .map(
        (line, i) =>
          (blocks.value === '1. ' ? i + 1 + '. ' : blocks.value) +
          line.replace(/^(?:#{1,3} |-# |> |- |\d+\. )/, ''),
      )
      .join('\n');
    input.setRangeText(value, start, end, 'select');
    blocks.value = '';
    input.focus({ preventScroll: true });
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  input.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const index = { b: 0, i: 1, u: 2, e: 5 }[event.key.toLowerCase()];
    if (index === undefined) return;
    event.preventDefault();
    wrap(formats[index]);
  });
  toolbar.append(blocks);
  input.replaceWith(editor);
  editor.append(toolbar, input);
}

export function autoFormatField(input, format) {
  input.addEventListener('blur', () => {
    const value = format(input.value);
    if (value === input.value) return;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export function fieldValidator(input, validate, label = input.labels?.[0]?.textContent.trim()) {
  const error = el('p', '', 'field-error');
  error.id = input.id + '-error';
  error.hidden = true;
  (input.closest('.slug-field, .clr-field, .emoji-input, .markdown-editor') || input).after(error);
  input.setAttribute(
    'aria-describedby',
    [input.getAttribute('aria-describedby'), error.id].filter(Boolean).join(' '),
  );
  return (reveal = true) => {
    let message = '';
    try {
      validate(input.value);
    } catch (invalid) {
      message = invalid.message;
    }
    input.setCustomValidity(message);
    input.setAttribute('aria-invalid', String(!!message && reveal));
    error.textContent = reveal ? message : '';
    error.hidden = !message || !reveal;
    return message ? { input, label, message } : null;
  };
}

const names = { 10: 'text', 9: 'section', 12: 'gallery', 1: 'buttons', 14: 'separator' };
export const newBlock = (type) =>
  ({
    10: { type: 10, content: '' },
    9: {
      type: 9,
      components: [{ type: 10, content: '' }],
      accessory: { type: 11, media: { url: '' } },
    },
    12: { type: 12, items: [{ media: { url: '' } }] },
    1: { type: 1, components: [{ type: 2, style: 5, label: 'open', url: '' }] },
    14: { type: 14, divider: true, spacing: 1 },
  })[type];

export function collapseDragZone(zone, selector) {
  let items = [],
    minHeight = '',
    alignContent = '',
    paddingTop = '';
  function keepPosition(item, top) {
    const delta = item.getBoundingClientRect().top - top;
    let scroller = zone.parentElement;
    while (scroller && scroller !== document.body) {
      if (
        /(auto|scroll)/.test(getComputedStyle(scroller).overflowY) &&
        scroller.scrollHeight > scroller.clientHeight
      )
        break;
      scroller = scroller.parentElement;
    }
    if (scroller && scroller !== document.body) scroller.scrollTop += delta;
    else window.scrollBy({ top: delta, behavior: 'instant' });
    return top - item.getBoundingClientRect().top;
  }
  return {
    onChoose({ item }) {
      const top = item.getBoundingClientRect().top;
      const padding = parseFloat(getComputedStyle(zone).paddingTop) || 0;
      minHeight = zone.style.minHeight;
      alignContent = zone.style.alignContent;
      paddingTop = zone.style.paddingTop;
      zone.style.minHeight = zone.getBoundingClientRect().height + 'px';
      zone.style.alignContent = 'start';
      const direct = selector.trim().replace(/^>\s*/, '');
      items = [...zone.children]
        .filter((node) => node.matches(direct))
        .map((node) => [node, node.classList.contains('drag-collapsed')]);
      items.forEach(([node]) => node.classList.add('drag-collapsed'));
      const remaining = keepPosition(item, top);
      if (remaining > 0) zone.style.paddingTop = padding + remaining + 'px';
    },
    onUnchoose({ item }) {
      const top = item.getBoundingClientRect().top;
      items.forEach(([node, wasCollapsed]) =>
        node.classList.toggle('drag-collapsed', wasCollapsed),
      );
      zone.style.minHeight = minHeight;
      zone.style.alignContent = alignContent;
      zone.style.paddingTop = paddingTop;
      keepPosition(item, top);
      items = [];
    },
  };
}

export function createComposer(container, onChange) {
  let root = {
    type: 17,
    accent_color: 5793266,
    components: [{ type: 10, content: '## new card' }],
  };
  let sortables = [],
    validators = [];
  const collapsed = new WeakSet();
  const status = el('span', undefined, 'sr-only');
  status.setAttribute('role', 'status');
  function changed() {
    onChange(copy(root));
  }
  function focusHandle(items, index) {
    if (items === root.badges) {
      container
        .querySelectorAll(':scope > .composer-item .drag-handle')
        [index]?.focus({ preventScroll: true });
      return;
    }
    const parent =
      items === root.components
        ? container
        : container.querySelectorAll('.component-editor')[
            root.components.indexOf(blockForItems(items))
          ];
    const selector =
      items === root.components
        ? ':scope > .component-editor > .card-titlebar > .drag-handle'
        : ':scope > .component-body > .composer-item > .card-titlebar > .drag-handle';
    parent?.querySelectorAll(selector)[index]?.focus({ preventScroll: true });
  }
  function reorder(items, from, to, name) {
    if (from === to || to < 0 || to >= items.length) return;
    items.splice(to, 0, items.splice(from, 1)[0]);
    draw();
    changed();
    focusHandle(items, to);
    status.textContent = name + ' moved to position ' + (to + 1) + ' of ' + items.length;
  }
  function dragHandle(items, index, name, kind) {
    const handle = el('button', undefined, 'drag-handle ' + kind + '-handle');
    handle.type = 'button';
    handle.append(icon('grip-vertical'));
    handle.setAttribute('aria-label', 'reorder ' + name);
    handle.title = 'drag to reorder; use up and down arrow keys';
    handle.disabled = items.length < 2;
    handle.addEventListener('click', (event) => event.preventDefault());
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const to =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : index + (event.key === 'ArrowUp' ? -1 : 1);
      reorder(items, index, to, name);
    });
    return handle;
  }
  function sortable(parent, items, selector, kind, name) {
    sortables.push(
      new Sortable(parent, {
        draggable: selector,
        ...collapseDragZone(parent, selector),
        handle: '.' + kind + '-handle',
        animation: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 91,
        ghostClass: 'reorder-placeholder',
        chosenClass: 'reorder-chosen',
        fallbackOnBody: true,
        forceFallback: true,
        fallbackTolerance: 4,
        swapThreshold: 0.65,
        onEnd: (event) =>
          queueMicrotask(() =>
            reorder(items, event.oldDraggableIndex, event.newDraggableIndex, name),
          ),
      }),
    );
  }
  function field(parent, name, value, set, kind = 'text', options = {}) {
    const id = 'field-' + crypto.randomUUID();
    const label = el('label', name);
    label.htmlFor = id;
    const input = el(kind === 'textarea' ? 'textarea' : kind === 'select' ? 'select' : 'input');
    input.id = id;
    if (kind === 'select')
      for (const [value, text] of options.choices) {
        const item = el('option', text);
        item.value = value;
        input.append(item);
      }
    else if (kind !== 'textarea') input.type = kind;
    if (kind === 'checkbox') {
      input.checked = !!value;
      input.setAttribute('role', 'switch');
    } else input.value = value ?? '';
    if (kind === 'textarea') input.rows = 3;
    if (options.max) input.maxLength = options.max;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (kind === 'url') autoFormatField(input, formatUrl);
    input.addEventListener(kind === 'select' || kind === 'checkbox' ? 'change' : 'input', () => {
      set(
        kind === 'checkbox' ? input.checked : kind === 'number' ? Number(input.value) : input.value,
      );
      changed();
    });
    const group = el('div', undefined, kind === 'checkbox' ? 'check-field' : 'composer-field');
    if (kind === 'checkbox') {
      label.append(input);
      group.append(label);
    } else group.append(label, input);
    parent.append(group);
    if (kind === 'textarea') markdownToolbar(input);
    if (kind !== 'checkbox')
      validators.push(
        fieldValidator(
          input,
          (value) => {
            validateText(
              value,
              name,
              options.max ?? Infinity,
              !options.optional && (kind === 'url' || kind === 'textarea'),
            );
            if (options.choices && !options.choices.some(([choice]) => String(choice) === value))
              throw new Error('choose a valid ' + name + '.');
            if (options.validate) options.validate(value);
          },
          name,
        ),
      );
    return input;
  }
  function action(parent, label, callback, aria) {
    const symbol =
      { '↑': 'arrow-up', '↓': 'arrow-down', duplicate: 'copy', remove: 'trash-2' }[label] ||
      (label.startsWith('+ ') ? 'plus' : label.startsWith('remove ') ? 'trash-2' : null);
    const text = ['↑', '↓'].includes(label) ? '' : label.replace(/^\+ /, '');
    const button = el('button', text, 'text-button');
    button.type = 'button';
    if (symbol) button.prepend(icon(symbol));
    if (aria) {
      button.setAttribute('aria-label', aria);
      button.title = aria;
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      callback();
      draw();
      changed();
    });
    parent.append(button);
    return button;
  }
  function buttonFields(parent, node) {
    const pair = el('div', undefined, 'field-pair');
    field(
      pair,
      'label',
      node.label,
      (value) => {
        if (value) node.label = value;
        else delete node.label;
      },
      'text',
      {
        max: 80,
        validate: (value) => {
          if (value) validateText(value, 'button label', 80, true);
          else if (!node.emoji) throw new Error('button needs a label or emoji.');
        },
      },
    );
    field(
      pair,
      'url',
      node.url,
      (value) => {
        node.url = value;
      },
      'url',
      {
        max: 512,
        placeholder: 'https://example.com',
        validate: (value) => publicHttpUrl(value, 'button url', 512),
      },
    );
    parent.append(pair);
    const emoji = field(
      parent,
      'emoji',
      node.emoji?.id
        ? '<' +
            (node.emoji.animated ? 'a' : '') +
            ':' +
            (node.emoji.name || 'emoji') +
            ':' +
            node.emoji.id +
            '>'
        : node.emoji?.name || '',
      (value) => {
        const custom = value.match(/^<(a?):(\w+):(\d+)>$/);
        if (!value) delete node.emoji;
        else
          node.emoji = custom
            ? { name: custom[2], id: custom[3], animated: !!custom[1] }
            : { name: value, id: null };
      },
      'text',
      {
        placeholder: '😀 or <:name:id>',
        validate: (value) => {
          if (/^[:<]/.test(value) && !node.emoji?.id)
            throw new Error('choose an emoji suggestion or use <:name:id>.');
          if (value) normalizeEmoji(node.emoji);
        },
      },
    );
    const emojiRow = el('div', undefined, 'emoji-input');
    emoji.replaceWith(emojiRow);
    const choose = el('button', undefined, 'emoji-choose');
    choose.type = 'button';
    choose.append(icon('smile'));
    choose.setAttribute('aria-label', 'choose emoji');
    choose.setAttribute('aria-haspopup', 'dialog');
    choose.setAttribute('aria-expanded', 'false');
    choose.title = 'choose emoji';
    choose.addEventListener('click', () => openEmojiPicker(emoji, choose));
    emojiRow.append(emoji, choose);
    autocompleteEmoji(emoji);
    field(
      parent,
      'disabled',
      node.disabled,
      (value) => {
        if (value) node.disabled = true;
        else delete node.disabled;
      },
      'checkbox',
    );
  }
  function mediaFields(parent, item) {
    field(
      parent,
      'url',
      item.media?.url,
      (value) => {
        item.media = { url: value };
      },
      'url',
      {
        max: 2048,
        placeholder: 'https://example.com/image.png',
        validate: (value) =>
          item.type === 11 ? thumbnailUrl(value) : publicHttpUrl(value, 'media url'),
      },
    );
    field(
      parent,
      'alt text',
      item.description,
      (value) => {
        if (value) item.description = value;
        else delete item.description;
      },
      'text',
      { max: 1024 },
    );
    field(
      parent,
      'spoiler',
      item.spoiler,
      (value) => {
        if (value) item.spoiler = true;
        else delete item.spoiler;
      },
      'checkbox',
    );
  }
  function badgeFields(parent, badge) {
    field(
      parent,
      'image url',
      badge.image,
      (value) => {
        badge.image = value;
      },
      'url',
      {
        max: 2048,
        placeholder: 'https://example.com/badge.gif',
        validate: (value) => publicHttpUrl(value, 'badge image', 2048),
      },
    );
    field(
      parent,
      'link (optional)',
      badge.url,
      (value) => {
        if (value) badge.url = value;
        else delete badge.url;
      },
      'url',
      {
        max: 2048,
        optional: true,
        placeholder: 'https://example.com',
        validate: (value) => {
          if (value) publicHttpUrl(value, 'badge link', 2048);
        },
      },
    );
    field(
      parent,
      'alt text',
      badge.label,
      (value) => {
        if (value) badge.label = value;
        else delete badge.label;
      },
      'text',
      { max: 80 },
    );
  }
  function itemCard(parent, items, index, name, fields) {
    const badge = name === 'badge';
    const item = el('div', undefined, 'composer-item' + (badge ? ' badge-item' : ''));
    const heading = el('div', undefined, 'card-titlebar composer-item-heading');
    const content = badge ? el('div', undefined, 'component-body') : item;
    content.id ||= 'item-' + crypto.randomUUID();
    const title = badge
      ? el('button', undefined, 'block-toggle')
      : el('span', name + ' ' + (index + 1), 'composer-item-title');
    if (badge) {
      title.type = 'button';
      title.append(el('span', 'badge ' + (index + 1), 'block-title'), icon('chevron-down'));
      title.setAttribute('aria-controls', content.id);
      const sync = () => {
        content.hidden = collapsed.has(items[index]);
        title.setAttribute('aria-expanded', String(!content.hidden));
        item.toggleAttribute('data-collapsed', content.hidden);
      };
      title.addEventListener('click', () => {
        if (collapsed.has(items[index])) collapsed.delete(items[index]);
        else collapsed.add(items[index]);
        sync();
      });
      sync();
    }
    heading.append(dragHandle(items, index, name, 'item'), title);
    const moves = el('div', undefined, badge ? 'item-actions block-actions' : 'item-actions');
    const move = (offset, label) => {
      const button = action(
        moves,
        offset < 0 ? '↑' : '↓',
        () => {
          [items[index], items[index + offset]] = [items[index + offset], items[index]];
        },
        'move ' + name + ' ' + label,
      );
      button.disabled = index + offset < 0 || index + offset >= items.length;
      button.addEventListener('click', () => focusHandle(items, index + offset));
    };
    move(-1, 'up');
    move(1, 'down');
    const duplicate = action(
      moves,
      'duplicate',
      () => {
        const clone = copy(items[index]);
        if ('id' in clone) delete clone.id;
        items.splice(index + 1, 0, clone);
      },
      'duplicate ' + name,
    );
    duplicate.replaceChildren(icon('copy'));
    duplicate.disabled =
      name === 'badge'
        ? items.length >= MAX_BADGES
        : items.length >= (name === 'button' ? 5 : 10) ||
          (name === 'button'
            ? componentStats(root).components >= 40
            : componentStats(root).media >= 10);
    heading.append(moves);
    item.append(heading);
    fields(content, items[index]);
    if (badge) {
      const remove = action(moves, 'remove', () => items.splice(index, 1), 'remove badge');
      remove.replaceChildren(icon('trash-2'));
      item.append(content);
      parent.append(item);
      return;
    }
    const footer = el('div', undefined, 'item-footer');
    const check = item.querySelector(':scope > .check-field');
    if (check) footer.append(check);
    action(footer, 'remove ' + name, () => items.splice(index, 1)).classList.add(
      'button',
      'danger',
      'secondary',
      'small',
    );
    item.append(footer);
    parent.append(item);
  }
  function blockForItems(items) {
    return root.components.find((block) => block.items === items || block.components === items);
  }
  function draw() {
    sortables.forEach((list) => list.destroy());
    sortables = [];
    validators = [];
    container.replaceChildren();
    container.classList.toggle('badge-case-editor', isBadgeCase(root));
    if (isBadgeCase(root)) {
      field(
        container,
        'title',
        root.title,
        (value) => {
          root.title = value;
        },
        'text',
        { max: 256 },
      );
      field(
        container,
        'description',
        root.description,
        (value) => {
          if (value) root.description = value;
          else delete root.description;
        },
        'textarea',
        { max: 4096, optional: true },
      );
      container.append(
        el('p', '88 × 31 px badges. resized automatically; shown on your page only.', 'hint'),
      );
      root.badges.forEach((badge, index) =>
        itemCard(container, root.badges, index, 'badge', badgeFields),
      );
      const add = action(container, '+ badge', () => root.badges.push({ image: '' }));
      add.disabled = root.badges.length >= MAX_BADGES;
      container.append(status);
      sortable(container, root.badges, '> .composer-item', 'item', 'badge');
      return;
    }
    root.components.forEach((block, index) => {
      const shell = el('section', undefined, 'component-editor');
      const heading = el('div', undefined, 'card-titlebar');
      const content = el('div', undefined, 'component-body');
      content.id = 'block-' + crypto.randomUUID();
      const toggle = el('button', undefined, 'block-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-controls', content.id);
      toggle.append(el('span', names[block.type], 'block-title'), icon('chevron-down'));
      const syncCollapsed = () => {
        content.hidden = collapsed.has(block);
        toggle.setAttribute('aria-expanded', String(!content.hidden));
        shell.toggleAttribute('data-collapsed', content.hidden);
      };
      toggle.addEventListener('click', () => {
        if (collapsed.has(block)) collapsed.delete(block);
        else collapsed.add(block);
        syncCollapsed();
      });
      syncCollapsed();
      heading.append(
        dragHandle(root.components, index, names[block.type] + ' block', 'block'),
        toggle,
      );
      shell.append(heading, content);
      const actions = el('span', undefined, 'block-actions');
      const up = action(
        actions,
        '↑',
        () => {
          [root.components[index - 1], root.components[index]] = [
            block,
            root.components[index - 1],
          ];
        },
        'move block up',
      );
      up.disabled = !index;
      const down = action(
        actions,
        '↓',
        () => {
          [root.components[index + 1], root.components[index]] = [
            block,
            root.components[index + 1],
          ];
        },
        'move block down',
      );
      down.disabled = index === root.components.length - 1;
      const duplicate = action(
        actions,
        'duplicate',
        () => root.components.splice(index + 1, 0, copy(block)),
        'duplicate block',
      );
      duplicate.replaceChildren(icon('copy'));
      const remove = action(
        actions,
        'remove',
        () => root.components.splice(index, 1),
        'remove block',
      );
      remove.replaceChildren(icon('trash-2'));
      heading.append(actions);
      if (block.type === 10)
        field(
          content,
          'markdown',
          block.content,
          (value) => {
            block.content = value;
          },
          'textarea',
        );
      if (block.type === 1) {
        block.components.forEach((item, i) =>
          itemCard(content, block.components, i, 'button', buttonFields),
        );
        const add = action(content, '+ button', () =>
          block.components.push({ type: 2, style: 5, label: '', url: '' }),
        );
        add.disabled = block.components.length >= 5;
      }
      if (block.type === 12) {
        block.items.forEach((item, i) => itemCard(content, block.items, i, 'media', mediaFields));
        const add = action(content, '+ image / video', () =>
          block.items.push({ media: { url: '' } }),
        );
        add.disabled = block.items.length >= 10;
      }
      if (block.type === 9) {
        block.components.forEach((text, i) => {
          field(
            content,
            'markdown ' + (i + 1),
            text.content,
            (value) => {
              text.content = value;
            },
            'textarea',
          );
          if (block.components.length > 1)
            action(content, 'remove text', () => block.components.splice(i, 1));
        });
        const add = action(content, '+ text', () =>
          block.components.push({ type: 10, content: '' }),
        );
        add.disabled = block.components.length >= 3;
        field(
          content,
          'accessory',
          block.accessory.type,
          (value) => {
            block.accessory =
              Number(value) === 11
                ? { type: 11, media: { url: '' } }
                : { type: 2, style: 5, label: 'open', url: '' };
            draw();
          },
          'select',
          {
            choices: [
              [11, 'thumbnail'],
              [2, 'button'],
            ],
          },
        );
        const sub = el('div', undefined, 'composer-item');
        const heading = el('div', undefined, 'card-titlebar');
        heading.append(
          el('span', block.accessory.type === 11 ? 'thumbnail' : 'button', 'composer-item-title'),
        );
        sub.append(heading);
        if (block.accessory.type === 11) mediaFields(sub, block.accessory);
        else buttonFields(sub, block.accessory);
        content.append(sub);
      }
      if (block.type === 14) {
        field(
          content,
          'show divider',
          block.divider !== false,
          (value) => {
            block.divider = value;
          },
          'checkbox',
        );
        field(
          content,
          'spacing',
          block.spacing || 1,
          (value) => {
            block.spacing = Number(value);
          },
          'select',
          {
            choices: [
              [1, 'small'],
              [2, 'large'],
            ],
          },
        );
      }
      container.append(shell);
      if (block.type === 1)
        sortable(content, block.components, '> .composer-item', 'item', 'button');
      if (block.type === 12) sortable(content, block.items, '> .composer-item', 'item', 'media');
    });
    container.append(status);
    sortable(container, root.components, '> .component-editor', 'block', 'block');
  }
  draw();
  return {
    get: () => copy(root),
    validate: (reveal = true) =>
      validators
        .map((validate) => validate(reveal))
        .filter(Boolean)
        .map((error) => {
          const block = error.input.closest('.component-editor');
          if (!block) return { ...error, label: 'badge case — ' + error.label };
          const index =
            [...container.querySelectorAll(':scope > .component-editor')].indexOf(block) + 1;
          const context = [
            block.querySelector('.block-title')?.textContent + ' ' + index,
            error.input.closest('.composer-item')?.querySelector('.composer-item-title')
              ?.textContent,
          ]
            .filter(Boolean)
            .join(', ');
          return { ...error, label: context + ' — ' + error.label };
        }),
    set: (value) => {
      root = copy(value);
      draw();
      changed();
    },
    add: (type) => {
      root.components.push(newBlock(Number(type)));
      draw();
      changed();
    },
    color: (value) => {
      root.accent_color = value === null ? null : parseInt(value.slice(1), 16);
      changed();
    },
    spoiler: (value) => {
      if (value) root.spoiler = true;
      else delete root.spoiler;
      changed();
    },
  };
}
