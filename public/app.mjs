import {
  normalizeCard,
  normalizeComponent,
  normalizeSlug,
  normalizeColor,
  normalizeReportLink,
  formatUrl,
  formatColor,
  formatSlug,
  text as validateText,
  buildEmbed,
  componentStats,
  payloadBytes,
  embedScript,
  httpsUrl,
  destinationUrl,
  MAX_BYTES,
} from './model.mjs';
import { createComposer, renderComponent, fieldValidator, autoFormatField } from './components.mjs';
import { importCardJson, messageJson, linkedEmbedCode } from './interchange.mjs';
import { icon, mountIcons } from './icons.mjs';
import Coloris from './vendor/coloris.mjs';

const $ = (selector) => document.querySelector(selector);
const siteHeader = $('.site-header');
const siteNav = $('#site-nav'),
  navToggle = $('#nav-toggle');
function syncHeaderVisibility() {
  const hidden = window.scrollY > 0;
  if (siteHeader.inert === hidden) return;
  siteHeader.classList.toggle('is-hidden', hidden);
  siteHeader.inert = hidden;
}
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty(
    '--toolbar-height',
    entry.target.getBoundingClientRect().height + 'px',
  );
}).observe($('.editor-toolbar'));
const fields = {
  url: $('#source-url'),
  title: $('#title'),
  description: $('#description'),
  color: $('#color'),
  slug: $('#slug'),
};
let loading = false,
  jsonDirty = false,
  jsonEditor;
const composer = createComposer($('#component-list'), () => {
  if (!loading) changed();
});
let editing = null,
  dirty = false,
  slugEdited = false,
  showErrors = false,
  usingTemplate = true;
let restoring = true;
let authenticated = false,
  newToken = '',
  busy = false,
  controls = [],
  refreshVersion = 0,
  toastTimer;
let resumeEditor = false,
  authBusy = false;

const mobile = matchMedia('(max-width: 760px)');
let mobileTab = 'edit';
Coloris.init();
Coloris({
  el: '#color',
  format: 'hex',
  alpha: false,
  themeMode: 'auto',
  margin: 8,
  swatches: [
    '#5865f2',
    '#e85d9e',
    '#22c55e',
    '#f59e0b',
    '#ef4444',
    '#06b6d4',
    '#8b5cf6',
    '#ffffff',
  ],
  closeButton: true,
  closeLabel: 'done',
  a11y: { open: 'choose accent color', close: 'close color picker' },
});
const fieldChecks = [
  fieldValidator(
    fields.url,
    (value) => destinationUrl(value.trim(), cardUrl(fields.slug.value)),
    'destination url',
  ),
  fieldValidator(fields.title, (value) => validateText(value, 'card name', 256, true), 'card name'),
  fieldValidator(fields.slug, normalizeSlug, 'custom link'),
  fieldValidator(
    fields.description,
    (value) => validateText(value, 'fallback description', 4096),
    'fallback description',
  ),
  fieldValidator(
    fields.color,
    (value) => normalizeColor($('#no-accent').checked ? null : value),
    'accent color',
  ),
];
for (const input of [fields.url, $('#url-import-value')]) autoFormatField(input, formatUrl);
autoFormatField(fields.color, formatColor);
autoFormatField(fields.slug, formatSlug);
const publicOrigin = new URL($('meta[property="og:url"]')?.content || location.origin).origin;
const publicHost = new URL(publicOrigin).host;
const cardUrl = (slug) => publicOrigin + '/' + slug;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 2400);
}

function confirmAction(message, label = 'continue') {
  const dialog = $('#confirm-dialog');
  if (busy || dialog.open) return Promise.resolve(false);
  $('#confirm-heading').textContent = message;
  $('#confirm-action').textContent = label;
  dialog.returnValue = 'cancel';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {
      once: true,
    });
    dialog.showModal();
  });
}

function showView(view, focus = true) {
  if (busy) return;
  document.body.dataset.view = view;
  history.replaceState(null, '', view === 'cards' ? '#cards' : location.pathname + location.search);
  $('#cards-view').hidden = view !== 'cards';
  $('#editor-view').hidden = view !== 'editor';
  $('#show-cards').setAttribute('aria-current', view === 'cards' ? 'page' : 'false');
  if (focus)
    (view === 'cards' ? $('#cards-heading') : $('#editor-heading')).focus({ preventScroll: true });
  window.scrollTo(0, 0);
  syncHeaderVisibility();
  saveEditor();
}

function setTab(tab) {
  mobileTab = tab;
  const target = mobile.matches ? $('#mobile-actions-menu') : $('.toolbar-actions');
  if ($('#edit-json').parentElement !== target) {
    closeMenus();
    if (mobile.matches) target.append($('#edit-json'), $('#export-toggle'), $('#show-embed'));
    else target.prepend($('#edit-json'), $('#export-toggle'), $('#show-embed'));
  }
  for (const name of ['edit', 'preview']) {
    const button = $('#' + name + '-tab');
    button.setAttribute('aria-selected', String(tab === name));
    button.tabIndex = tab === name ? 0 : -1;
  }
  $('#card-form').hidden = mobile.matches && tab !== 'edit';
  $('#live-preview').hidden = mobile.matches && tab !== 'preview';
  for (const panel of [$('#card-form'), $('#live-preview')]) {
    if (mobile.matches) panel.setAttribute('role', 'tabpanel');
    else panel.removeAttribute('role');
  }
  saveEditor();
}
for (const name of ['edit', 'preview'])
  $('#' + name + '-tab').addEventListener('click', () => setTab(name));
$('.maker-tablist').addEventListener('keydown', (event) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const tab =
      event.key === 'Home'
        ? 'edit'
        : event.key === 'End'
          ? 'preview'
          : mobileTab === 'edit'
            ? 'preview'
            : 'edit';
    setTab(tab);
    $('#' + tab + '-tab').focus();
  }
});
function syncNavigation() {
  closeMenus();
  if (mobile.matches) siteNav.setAttribute('popover', 'auto');
  else siteNav.removeAttribute('popover');
}
siteNav.addEventListener('beforetoggle', (event) => {
  const open = event.newState === 'open';
  navToggle.setAttribute('aria-expanded', String(open));
  navToggle.setAttribute('aria-label', open ? 'close navigation' : 'open navigation');
  if (!open) return;
  const rect = navToggle.getBoundingClientRect();
  siteNav.style.left = Math.max(12, Math.min(rect.right - 220, innerWidth - 232)) + 'px';
  siteNav.style.top = rect.bottom + 8 + 'px';
});
siteNav.addEventListener('click', (event) => {
  if (event.target.closest('a, button')) closeMenus();
});
mobile.addEventListener('change', () => {
  setTab(mobileTab);
  syncNavigation();
});

function setBusy(value) {
  busy = value;
  $('#card-form').inert = value;
  if (value) {
    Coloris.close();
    controls = [...document.querySelectorAll('input, textarea, button, select')].map((control) => [
      control,
      control.disabled,
    ]);
    controls.forEach(([control]) => {
      control.disabled = true;
    });
  } else {
    controls.forEach(([control, disabled]) => {
      control.disabled = disabled;
    });
    fields.slug.disabled = false;
    update();
  }
  $('#json-panel').inert = value;
  $('#account-panel').setAttribute('aria-busy', String(value));
  $('#sign-in-dialog').setAttribute('aria-busy', String(value));
  $('#report-dialog').setAttribute('aria-busy', String(value));
  $('#publish-dialog').setAttribute('aria-busy', String(value));
  $('#account-new-token').setAttribute('aria-busy', String(value));
  $('#card-form').setAttribute('aria-busy', String(value));
}

function slugify(value) {
  return formatSlug(value);
}

function draft() {
  return {
    title: fields.title.value.trim(),
    description: fields.description.value.trim(),
    url: fields.url.value.trim() || null,
    color: $('#no-accent').checked ? null : fields.color.value,
    component: composer.get(),
  };
}

function saveEditor() {
  if (restoring) return false;
  try {
    sessionStorage.setItem(
      'linkbed-editor',
      JSON.stringify({
        view: document.body.dataset.view,
        tab: mobileTab,
        scroll: scrollY,
        embedMode: $('#embed-mode').value,
        showErrors,
        draft: !usingTemplate
          ? {
              card: {
                ...draft(),
                title: fields.title.value,
                description: fields.description.value,
                url: fields.url.value,
              },
              slug: fields.slug.value,
              color: fields.color.value,
              editing,
              dirty,
              slugEdited,
              json: jsonDirty ? $('#component-json').value : null,
            }
          : null,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function restoreEditor() {
  try {
    const state = JSON.parse(sessionStorage.getItem('linkbed-editor'));
    if (!state || location.hash === '#new') return null;
    const saved = state.draft;
    if (saved) {
      if (
        !saved.card ||
        saved.card.component?.type !== 17 ||
        !Array.isArray(saved.card.component.components) ||
        !['url', 'title', 'description'].every((key) => typeof saved.card[key] === 'string') ||
        typeof saved.slug !== 'string' ||
        typeof saved.color !== 'string' ||
        (saved.editing !== null && typeof saved.editing !== 'string')
      )
        return null;
      usingTemplate = false;
      fill(saved.card, saved.slug);
      fields.color.value = saved.color;
      editing = saved.editing;
      dirty = !!saved.dirty;
      slugEdited = !!saved.slugEdited;
      if (typeof saved.json === 'string') {
        jsonDirty = true;
        $('#component-json').value = saved.json;
      }
    }
    showErrors = !!state.showErrors;
    $('#embed-mode').value = state.embedMode === 'live' ? 'live' : 'snapshot';
    update();
    return state;
  } catch {
    reset(false);
    return null;
  }
}

function update() {
  const card = draft();
  $('#delete-card').hidden = !editing;
  renderComponent($('#preview-card'), card.component);
  const stats = componentStats(card.component);
  $('#component-count').textContent = stats.components + ' / 40 · ' + stats.media + ' / 10 media';
  $('#add-component').disabled = busy || stats.components >= 40;
  $('#preview-url').textContent = publicHost + '/' + (fields.slug.value || 'your-card');
  $('#slug-prefix').textContent = publicHost + '/';
  $('#slug-hint').textContent =
    editing && fields.slug.value !== editing ? 'old link stops working after save.' : '';
  const bytes = payloadBytes(card);
  $('#byte-count').textContent = bytes.toLocaleString() + ' / 3,000 bytes';
  $('#byte-count').classList.toggle('over-limit', bytes > MAX_BYTES);
  const errors = validateEditor(card);
  $('#publish-button').disabled = busy || jsonDirty;
  if (!busy) $('#publish-label').textContent = editing ? 'save changes' : 'publish';
  fields.color.disabled = busy || $('#no-accent').checked;
  const colorButton = fields.color.parentElement.querySelector('button');
  if (colorButton) colorButton.disabled = fields.color.disabled;
  fields.color.parentElement.style.color = fields.color.value;
  const live = $('#embed-mode').value === 'live';
  let embedReady =
    !errors.some(({ input }) => !input || input.closest('#component-list')) && !jsonDirty;
  $('#embed-code').value = live ? '' : embedScript(card);
  $('#embed-code').rows = live ? 3 : 8;
  $('#embed-hint').textContent = live
    ? 'paste into your page’s html head, then add the server route below.'
    : 'paste into your page’s html head. copy again after edits.';
  if (live) {
    embedReady = embedReady && !!editing && !dirty;
    if (!editing) $('#embed-hint').textContent = 'publish your card first to create a live embed.';
    else if (dirty || jsonDirty)
      $('#embed-hint').textContent = 'save your changes before using the live embed.';
    if (embedReady) {
      try {
        const code = linkedEmbedCode(card.url, publicOrigin + '/api/embeds/' + editing);
        if (!card.url)
          $('#embed-hint').textContent =
            'replace your-site.com with your website’s domain, then add this code to its html head and the server route below.';
        $('#embed-code').value = code.head;
        $('#embed-route').value = code.route;
      } catch (error) {
        embedReady = false;
        $('#embed-hint').textContent = error.message;
      }
    }
  }
  $('#embed-code').hidden = live && !embedReady;
  $('#embed-live').hidden = !live || !embedReady;
  $('#copy-code').disabled = busy || !embedReady;
  $('#copy-route').disabled = busy || !embedReady;
  $('#copy-prompt').disabled = busy || !embedReady;
  if (!jsonDirty) {
    const value = JSON.stringify({ component: card.component }, null, 2);
    $('#component-json').value = value;
    jsonEditor?.set(value);
  }
  $('#editor-notice').hidden = !editing && !dirty && !usingTemplate;
  $('#copy-card-link').hidden = !editing;
  $('#copy-card-link').disabled = busy;
  $('#clear-template').textContent = editing || dirty ? 'clear changes' : 'clear template';
  $('#clear-template').disabled = busy;
  $('#editor-notice').classList.toggle('has-changes', dirty || usingTemplate);
  const notice = $('#editor-notice-text');
  notice.replaceChildren();
  if (usingTemplate) notice.textContent = 'start with this template, or clear it to make your own.';
  if (dirty)
    notice.append(
      document.createTextNode(
        'you have unsaved changes' + (editing ? '. ' : '. publish to save your card.'),
      ),
    );
  if (editing) {
    const link = element('a', cardUrl(editing));
    link.href = cardUrl(editing);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    notice.append(document.createTextNode('this card is published at '), link);
  }
  saveEditor();
}

function validateEditor(card = draft()) {
  const componentErrors = composer.validate(showErrors);
  const errors = [
    ...fieldChecks.map((check) => check(showErrors)).filter(Boolean),
    ...componentErrors,
  ];
  if (!componentErrors.length) {
    try {
      normalizeComponent(card.component);
    } catch (invalid) {
      errors.push({ message: invalid.message });
    }
  }
  const stats = componentStats(card.component);
  for (const [invalid, message] of [
    [stats.components > 40, 'use up to 40 components.'],
    [stats.media > 10, 'use up to ten gallery items across the embed.'],
    [
      payloadBytes(card) > MAX_BYTES,
      'card exceeds discord’s 3,000-byte limit. shorten text or remove a link or image.',
    ],
  ]) {
    if (invalid && !errors.some((error) => error.message === message)) errors.push({ message });
  }
  if (jsonDirty) errors.push({ message: 'apply json before publishing.' });
  const visibleErrors = showErrors ? errors : [];
  $('#validation-list').replaceChildren(
    ...visibleErrors.map(({ input, label, message }) => {
      const row = element('li');
      const link = element(input ? 'a' : 'span', label ? label + ': ' + message : message);
      if (input) {
        link.href = '#' + input.id;
        link.addEventListener('click', (event) => {
          event.preventDefault();
          setTab('edit');
          for (let parent = input.parentElement; parent; parent = parent.parentElement) {
            if (parent.tagName === 'DETAILS') parent.open = true;
            if (parent.matches('.component-editor[data-collapsed]'))
              parent.querySelector('.block-toggle').click();
          }
          input.focus({ preventScroll: true });
          input.scrollIntoView({
            block: 'center',
            behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          });
        });
      }
      row.append(link);
      return row;
    }),
  );
  $('#validation-list').hidden = visibleErrors.length === 0;
  $('#editor-errors').hidden = visibleErrors.length === 0 && !$('#form-status').textContent;
  return errors;
}

function changed() {
  usingTemplate = false;
  dirty = true;
  showErrors = true;
  $('#form-status').textContent = '';
  update();
}

function fill(card, slug = '') {
  loading = true;
  for (const name of ['url', 'title', 'description']) fields[name].value = card[name] ?? '';
  const component = buildEmbed({ images: [], buttons: [], ...card }).component;
  fields.color.value = '#' + (component.accent_color ?? 0x5865f2).toString(16).padStart(6, '0');
  $('#no-accent').checked = component.accent_color == null;
  $('#card-spoiler').checked = !!component.spoiler;
  fields.slug.value = slug;
  fields.slug.disabled = busy;
  composer.set(component);
  showErrors = false;
  jsonDirty = false;
  $('#json-error').textContent = '';
  loading = false;
  update();
}

async function withSessionLock(work) {
  if (!navigator.locks) throw new Error('update your browser to save cards safely.');
  return navigator.locks.request('linkbed-session', work);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'request failed.');
  return data;
}

function syncAccount() {
  $('#guest-notice').hidden = authenticated;
  if (newToken && !$('#account-new-token').open) $('#account-new-token').showModal();
  $('#sign-out').hidden = !authenticated || !!newToken;
  $('#saved-cards').hidden = false;
}

async function openCard(card) {
  if (busy || (dirty && !(await confirmAction('discard unsaved changes?', 'discard')))) return;
  editing = card.slug;
  usingTemplate = false;
  slugEdited = true;
  dirty = false;
  fill(card, card.slug);
  setTab('edit');
  showView('editor');
}

async function deleteCard(slug, errorNode) {
  if (
    busy ||
    !(await confirmAction('delete this card? its link will stop working.', 'delete card'))
  )
    return;
  setBusy(true);
  try {
    await api('/api/cards/' + slug, { method: 'DELETE' });
    if (editing === slug) await reset(false);
    await refreshCards();
    toast('deleted.');
  } catch (error) {
    errorNode.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function refreshCards() {
  const version = ++refreshVersion;
  try {
    const session = await api('/api/session');
    const cards = await api('/api/cards');
    if (version !== refreshVersion) return;
    authenticated = session.authenticated;
    syncAccount();
    $('#card-count').textContent = cards.length;
    $('#saved-list').replaceChildren(
      ...cards.map((card) => {
        const tile = element('article', undefined, 'saved-card');
        const open = element('button', undefined, 'saved-preview');
        open.type = 'button';
        open.setAttribute('aria-label', 'edit card: ' + card.title);
        const preview = element('div', undefined, 'discord-card');
        renderComponent(preview, buildEmbed(card).component);
        preview.inert = true;
        open.append(preview);
        open.addEventListener('click', () => openCard(card));
        const footer = element('div', undefined, 'saved-footer');
        footer.title = card.title;
        const remove = element('button', undefined, 'saved-delete');
        remove.type = 'button';
        remove.append(icon('trash-2'));
        remove.title = 'delete';
        remove.setAttribute('aria-label', 'delete card: ' + card.title);
        remove.addEventListener('click', () => deleteCard(card.slug, $('#account-error')));
        const url = element('a', undefined, 'saved-url');
        url.append(element('span', location.host + '/' + card.slug, 'saved-url-label'));
        url.href = cardUrl(card.slug);
        url.target = '_blank';
        url.rel = 'noopener noreferrer';
        url.title = location.host + '/' + card.slug;
        const external = icon('external-link');
        external.classList.add('saved-external');
        url.append(external);
        const copyLink = element('button', undefined, 'text-button saved-copy');
        copyLink.type = 'button';
        copyLink.append(icon('copy'));
        copyLink.title = 'copy link';
        copyLink.setAttribute('aria-label', 'copy link: ' + card.title);
        copyLink.addEventListener('click', () => copy(cardUrl(card.slug)));
        footer.append(url, copyLink, remove);
        tile.append(open, footer);
        return tile;
      }),
    );
    const tile = element('article', undefined, 'saved-card');
    const add = element('button', undefined, 'saved-add');
    add.type = 'button';
    add.setAttribute('aria-label', 'create a new card');
    const plus = icon('plus');
    add.append(plus, element('span', 'new card'));
    add.addEventListener('click', newCard);
    tile.append(add);
    $('#saved-list').append(tile);
  } catch (error) {
    if (version === refreshVersion) $('#account-error').textContent = error.message;
  }
}

async function reset(ask = true) {
  if (ask && (busy || (dirty && !(await confirmAction('discard unsaved changes?', 'discard')))))
    return false;
  editing = null;
  usingTemplate = true;
  dirty = false;
  slugEdited = false;
  $('#form-status').textContent = '';
  const starter = $('#starter-card');
  fill(
    starter
      ? JSON.parse(starter.textContent)
      : {
          url: 'https://ryanaque.com/',
          title: 'may 🦋',
          description: 'projects, notes, and things worth keeping.',
          component: {
            type: 17,
            accent_color: 0xa2abff,
            components: [
              {
                type: 9,
                components: [
                  {
                    type: 10,
                    content:
                      "## hi! i'm may 🦋\ni'm a flexible software engineer. i love butterflies, designing, and writing.",
                  },
                ],
                accessory: {
                  type: 11,
                  media: {
                    url: 'https://i.pinimg.com/originals/d8/04/2d/d8042d88f4fee3f133e56a3a5cfde0e3.gif',
                  },
                  description: 'funky',
                },
              },
              {
                type: 10,
                content:
                  'i make apps! here’s [pawl](https://pawl.cat), [hibi](https://hibi.garden), and [33](https://use33.app).',
              },
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 5,
                    label: 'portfolio',
                    url: 'https://ryanaque.com/',
                    emoji: { id: '1026533070955872337', name: 'blobcatcozy', animated: false },
                  },
                  {
                    type: 2,
                    style: 5,
                    label: 'github',
                    url: 'https://github.com/schmayterling',
                    emoji: { id: '1405656540303851520', name: 'github', animated: false },
                  },
                ],
              },
              { type: 14, divider: true, spacing: 1 },
              {
                type: 10,
                content:
                  "this embed was made with my project [linkbed](https://linkbed.me), it's free and oss!\n",
              },
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 5,
                    label: 'make your own',
                    url: 'https://linkbed.me/',
                    emoji: { id: '1565589317508800543', name: 'beantype', animated: true },
                  },
                  {
                    type: 2,
                    style: 5,
                    label: 'star the repo',
                    url: 'https://github.com/schmayterling/linkbed',
                    emoji: { id: '775142708125106186', name: 'ShyWant', animated: true },
                  },
                ],
              },
            ],
          },
        },
    'may',
  );
  return true;
}

async function newCard() {
  if (await reset()) {
    setTab('edit');
    showView('editor');
  }
}
document
  .querySelectorAll('.site-header a[href="#new"], .site-header a[href="#cards"]')
  .forEach((link) => {
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      if (link.hash === '#cards') {
        showView('cards');
        refreshCards();
      } else newCard();
    });
  });
async function clearChanges() {
  if (busy || (dirty && !(await confirmAction('discard unsaved changes?', 'discard')))) return;
  setBusy(true);
  try {
    const card = editing
      ? await api('/api/cards/' + editing)
      : {
          url: null,
          title: '',
          description: '',
          component: { type: 17, accent_color: null, components: [] },
        };
    usingTemplate = false;
    dirty = false;
    slugEdited = !!editing;
    $('#form-status').textContent = '';
    fill(card, editing || '');
  } catch (error) {
    $('#form-status').textContent = error.message;
  } finally {
    setBusy(false);
  }
}
$('#reset').addEventListener('click', clearChanges);
$('#clear-template').addEventListener('click', clearChanges);
$('#copy-card-link').addEventListener('click', () => copy(cardUrl(editing)));
$('#delete-card').addEventListener('click', () => {
  if (editing) deleteCard(editing, $('#form-status'));
});
for (const type of ['focusin', 'click', 'input', 'change'])
  $('#card-form').addEventListener(type, (event) => {
    if (loading || showErrors || event.target.closest('#editor-notice, #reset')) return;
    showErrors = true;
    update();
  });
$('#card-form').addEventListener('input', (event) => {
  if (event.target.closest('#component-list, .json-panel')) return;
  if (event.target === fields.slug) slugEdited = true;
  if (event.target === fields.title && !editing && !slugEdited)
    fields.slug.value = slugify(fields.title.value);
  if (event.target === fields.color || event.target.id === 'no-accent') {
    if ($('#no-accent').checked) {
      Coloris.close();
      composer.color(null);
    } else if (/^#[0-9a-f]{6}$/i.test(fields.color.value)) composer.color(fields.color.value);
    else changed();
  } else if (event.target.id === 'card-spoiler') composer.spoiler(event.target.checked);
  else changed();
});
$('#add-component').addEventListener('click', () => {
  if (busy) return;
  composer.add($('#component-type').value);
  $('#component-list').lastElementChild?.querySelector('textarea, input')?.focus();
});
function jsonChanged() {
  jsonDirty = true;
  changed();
  try {
    importCardJson($('#component-json').value);
    $('#json-error').textContent = '';
  } catch (error) {
    $('#json-error').textContent = error.message;
  }
}
$('#component-json').addEventListener('input', jsonChanged);
function applyJson(value) {
  const imported = importCardJson(value);
  fill(
    { ...draft(), ...imported },
    editing || (slugEdited ? fields.slug.value : slugify(imported.title || fields.title.value)),
  );
  changed();
}
$('#apply-json').addEventListener('click', () => {
  if (busy) return;
  try {
    applyJson($('#component-json').value);
    $('#json-panel').close();
  } catch (error) {
    $('#json-error').textContent = error.message;
  }
});
$('#copy-json').addEventListener('click', () => copy($('#component-json').value));
function closeMenus() {
  document
    .querySelectorAll('.toolbar-menu:popover-open, #site-nav:popover-open')
    .forEach((menu) => menu.hidePopover());
}
for (const [menuId, toggleId] of [
  ['export-menu', 'export-toggle'],
  ['mobile-actions-menu', 'actions-toggle'],
]) {
  const menu = $('#' + menuId),
    toggle = $('#' + toggleId);
  menu.addEventListener('beforetoggle', (event) => {
    toggle.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState !== 'open') return;
    const rect = (mobile.matches ? $('#actions-toggle') : toggle).getBoundingClientRect();
    menu.style.left = Math.max(12, Math.min(rect.right - 180, innerWidth - 192)) + 'px';
    menu.style.top = rect.bottom + 6 + 'px';
  });
}
$('#export-toggle').addEventListener('click', (event) => {
  if (!mobile.matches) return;
  event.preventDefault();
  closeMenus();
  $('#export-menu').showPopover();
  $('#copy-message-json').focus({ preventScroll: true });
});
$('#export-menu').addEventListener('toggle', (event) => {
  if (event.newState === 'closed' && mobile.matches)
    $('#actions-toggle').focus({ preventScroll: true });
});
window.addEventListener(
  'scroll',
  () => {
    syncHeaderVisibility();
    closeMenus();
  },
  { passive: true },
);
window.addEventListener('pageshow', syncHeaderVisibility);
window.addEventListener('resize', closeMenus);
function syncPickerOrigin(event) {
  const select = event.target.closest('select');
  if (!select) return;
  requestAnimationFrame(() => {
    if (!select.matches(':open')) return;
    const area = getComputedStyle(select, '::picker(select)').positionArea;
    select.toggleAttribute('data-opens-above', /^(self-start|block-start|top)(?: |$)/.test(area));
  });
}
for (const type of ['pointerdown', 'click', 'keydown'])
  document.addEventListener(type, syncPickerOrigin, true);
function exportJson(action) {
  if (busy) return;
  closeMenus();
  try {
    const card = jsonDirty ? importCardJson($('#component-json').value) : draft();
    action(messageJson(card));
    $('#json-error').textContent = '';
  } catch (error) {
    $('#form-status').textContent = error.message;
    validateEditor();
    toast(error.message);
  }
}
$('#copy-message-json').addEventListener('click', () => exportJson(copy));
$('#download-json').addEventListener('click', () =>
  exportJson((json) => {
    const url = URL.createObjectURL(new Blob([json + '\n'], { type: 'application/json' }));
    const link = element('a');
    link.href = url;
    link.download = (slugify(fields.slug.value) || 'card') + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }),
);
async function openJsonEditor() {
  if (busy) return;
  closeMenus();
  $('#json-panel').showModal();
  $('#component-json').focus();
  try {
    if (!jsonEditor) {
      const { createJsonEditor } = await import('./code-editor.mjs');
      if (!jsonEditor) jsonEditor = createJsonEditor($('#component-json'), jsonChanged);
    }
    if ($('#json-panel').open) jsonEditor.focus();
  } catch {
    $('#json-error').textContent = 'code editor unavailable. you can still edit the text.';
  }
}
$('#edit-json').addEventListener('click', openJsonEditor);
$('#format-json').addEventListener('click', () => {
  try {
    if (jsonEditor) jsonEditor.format();
    else {
      $('#component-json').value = JSON.stringify(JSON.parse($('#component-json').value), null, 2);
      jsonChanged();
    }
  } catch (error) {
    $('#json-error').textContent = error.message;
  }
});
$('#show-url-import').addEventListener('click', () => {
  if (busy) return;
  $('#url-import-value').value = fields.url.value;
  $('#url-import-error').textContent = '';
  $('#url-import-dialog').showModal();
});
$('#embed-mode').addEventListener('change', update);
$('#show-embed').addEventListener('click', () => {
  if (busy) return;
  closeMenus();
  $('#embed-dialog').showModal();
});
document.querySelectorAll('.tool-dialog').forEach((dialog) => {
  dialog.setAttribute('closedby', 'any');
  dialog.addEventListener('cancel', (event) => {
    if (busy) event.preventDefault();
  });
  if (!('closedBy' in dialog)) {
    const outside = (event) => {
      const rect = dialog.getBoundingClientRect();
      return (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      );
    };
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (event) => {
      pressedOutside = event.target === dialog && outside(event);
    });
    dialog.addEventListener('click', (event) => {
      if (pressedOutside && event.target === dialog && outside(event) && !busy) dialog.close();
      pressedOutside = false;
    });
  }
  dialog.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!busy) dialog.close();
    });
  });
});
$('#import-json-button').addEventListener('click', () => {
  if (!busy) $('#import-json').click();
});
$('#import-json').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file || busy) return;
  setBusy(true);
  try {
    if (file.size > 64000) throw new Error('json file is too large.');
    const value = await file.text();
    importCardJson(value);
    $('#component-json').value = value;
    jsonEditor?.set(value);
    jsonChanged();
  } catch (error) {
    $('#json-error').textContent = error.message;
  } finally {
    event.target.value = '';
    setBusy(false);
  }
});

const templates = {
  launch: {
    title: 'new release',
    description: '**ready to try.**\nsee what’s new.',
    buttons: [
      { label: 'try it', url: 'https://example.com/' },
      { label: 'docs', url: 'https://example.com/docs' },
    ],
  },
  portfolio: {
    title: 'my work',
    description: 'a few things i’ve made.',
    buttons: [
      { label: 'portfolio', url: 'https://example.com/' },
      { label: 'contact', url: 'https://example.com/contact' },
    ],
  },
  event: {
    title: 'you’re invited',
    description: 'join us for an evening of ideas.',
    buttons: [
      { label: 'details', url: 'https://example.com/' },
      { label: 'rsvp', url: 'https://example.com/rsvp' },
    ],
  },
};
document.querySelectorAll('[data-template]').forEach((button) =>
  button.addEventListener('click', async () => {
    if (busy || (dirty && !(await confirmAction('replace current draft?', 'replace')))) return;
    const template = templates[button.dataset.template];
    let source = 'https://example.com/';
    try {
      source = httpsUrl(fields.url.value);
    } catch {}
    fill(
      {
        ...template,
        color: fields.color.value,
        images: [],
        url: source,
        buttons: template.buttons.map((button) => ({
          ...button,
          url: new URL(new URL(button.url).pathname, source).href,
        })),
      },
      editing || slugify(template.title),
    );
    changed();
  }),
);

$('#url-import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  $('#url-import-error').textContent = '';
  try {
    const url = httpsUrl($('#url-import-value').value.trim());
    setBusy(true);
    $('#import-button').textContent = 'importing…';
    const card = await api('/api/import', { method: 'POST', body: JSON.stringify({ url }) });
    fill(card, editing || (slugEdited ? fields.slug.value : slugify(card.title)));
    changed();
    $('#url-import-dialog').close();
  } catch (error) {
    $('#url-import-error').textContent = error.message;
  } finally {
    $('#import-button').textContent = 'use template';
    setBusy(false);
  }
});

const publishDialog = $('#publish-dialog'),
  publishForm = $('#publish-form'),
  publishConfirm = $('#publish-confirm'),
  confirmPublish = $('#confirm-publish');
let termsAccepted = false;
$('#card-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy || jsonDirty || publishDialog.open) return;
  $('#form-status').textContent = '';
  showErrors = true;
  if (validateEditor().length) {
    setTab('edit');
    return;
  }
  try {
    termsAccepted ||= localStorage.getItem('linkbed-terms-accepted') === 'true';
  } catch {}
  publishForm.reset();
  publishForm.hidden = false;
  $('#publish-result').hidden = true;
  $('#publish-copy-error').textContent = '';
  $('#copy-published-label').textContent = 'copy link';
  $('#publish-message').textContent = 'anyone with this link can view your card:';
  publishConfirm.closest('label').hidden = termsAccepted;
  publishConfirm.required = !termsAccepted;
  publishConfirm.autofocus = !termsAccepted;
  confirmPublish.disabled = !termsAccepted;
  $('#publish-error').textContent = '';
  $('#publish-heading').textContent = editing ? 'save changes?' : 'publish card?';
  confirmPublish.textContent = editing ? 'save changes' : 'publish card';
  $('#publish-url').textContent = cardUrl(fields.slug.value);
  $('#publish-url').href = cardUrl(fields.slug.value);
  const renamed = editing && fields.slug.value !== editing;
  $('#publish-rename-warning').hidden = !renamed;
  $('#publish-rename-warning').textContent = renamed
    ? 'this changes /' + editing + ' to /' + fields.slug.value + '. the old link will stop working.'
    : '';
  closeMenus();
  publishDialog.showModal();
  if (termsAccepted) confirmPublish.focus();
});
publishConfirm.addEventListener('change', () => {
  confirmPublish.disabled = busy || (!termsAccepted && !publishConfirm.checked);
  $('#publish-error').textContent = '';
});
publishDialog.addEventListener('close', () => {
  publishForm.reset();
  confirmPublish.disabled = true;
  $('#publish-error').textContent = '';
});
publishForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (
    busy ||
    !publishDialog.open ||
    publishForm.hidden ||
    (!termsAccepted && !publishConfirm.checked)
  )
    return;
  if (validateEditor().length) {
    publishDialog.close();
    setTab('edit');
    return;
  }
  termsAccepted = true;
  try {
    localStorage.setItem('linkbed-terms-accepted', 'true');
  } catch {}
  let saved = false;
  try {
    const card = normalizeCard(draft(), cardUrl(fields.slug.value));
    setBusy(true);
    $('#publish-label').textContent = confirmPublish.textContent = 'saving…';
    $('#publish-error').textContent = '';
    const published = await withSessionLock(async () => {
      const session = await api('/api/session');
      if (!session.authenticated && !session.guest) {
        if (editing) throw new Error('edit access expired. sign in with your token to recover it.');
        await api('/api/guest', { method: 'POST', body: '{}' });
      }
      return api(editing ? '/api/cards/' + editing : '/api/cards', {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify({ ...card, slug: fields.slug.value }),
      });
    });
    editing = published.slug;
    usingTemplate = false;
    dirty = false;
    slugEdited = true;
    await refreshCards();
    saved = true;
  } catch (error) {
    $('#publish-error').textContent = error.message;
  } finally {
    setBusy(false);
    confirmPublish.textContent = editing ? 'save changes' : 'publish card';
  }
  if (saved) {
    $('#publish-heading').textContent = 'your card is ready.';
    $('#publish-message').textContent = 'copy this link to share your card:';
    $('#publish-url').textContent = $('#publish-url').href = cardUrl(editing);
    $('#publish-rename-warning').hidden = true;
    publishForm.hidden = true;
    $('#publish-result').hidden = false;
    $('#copy-published-link').focus();
  }
});

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('copied.');
    return true;
  } catch {
    toast('could not copy. select text to copy.');
    return false;
  }
}
$('#copy-published-link').addEventListener('click', async () => {
  const copied = await copy($('#publish-url').href);
  $('#copy-published-label').textContent = copied ? 'copied!' : 'copy link';
  $('#publish-copy-error').textContent = copied
    ? ''
    : 'could not copy. select the link to copy it.';
});
$('#copy-code').addEventListener('click', () => {
  try {
    normalizeComponent(composer.get());
    copy($('#embed-code').value);
  } catch (error) {
    $('#form-status').textContent = error.message;
    validateEditor();
  }
});
$('#copy-route').addEventListener('click', () => copy($('#embed-route').value));
$('#copy-prompt').addEventListener('click', async () => {
  const button = $('#copy-prompt');
  button.disabled = true;
  try {
    const response = await fetch('/prompt.md');
    if (!response.ok) throw new Error('prompt unavailable.');
    const prompt = (await response.text()).replaceAll('https://linkbed.me/xxxx', cardUrl(editing));
    await copy(prompt);
  } catch {
    toast('could not load the prompt. try again.');
  } finally {
    update();
  }
});

async function accountRequest(path, data = {}) {
  const errorNode = path === '/api/login' ? $('#sign-in-error') : $('#account-error');
  errorNode.textContent = '';
  refreshVersion++;
  setBusy(true);
  authBusy = true;
  try {
    return await withSessionLock(async () => {
      if (path === '/api/signup' && (await api('/api/session')).authenticated)
        throw new Error('already signed in. reload to see your cards.');
      return api(path, { method: 'POST', body: JSON.stringify(data) });
    });
  } catch (error) {
    errorNode.textContent = error.message;
  }
}
function finishAuth() {
  authBusy = false;
  setBusy(false);
  syncAccount();
}

document.querySelectorAll('.create-token').forEach((button) =>
  button.addEventListener('click', async () => {
    if (busy) return;
    resumeEditor = document.body.dataset.view === 'editor';
    showView('cards');
    const result = await accountRequest('/api/signup');
    if (result) {
      authenticated = true;
      newToken = result.token;
      $('#new-token').textContent = newToken;
      $('#download-token').removeAttribute('data-downloaded');
      $('#download-token').textContent = 'download';
      await refreshCards();
    }
    finishAuth();
    if (result) $('#copy-token').focus({ preventScroll: true });
  }),
);
const reportDialog = $('#report-dialog'),
  reportForm = $('#report-form'),
  reportUrl = $('#report-url'),
  reportConfirm = $('#report-confirm');
const checkReportUrl = fieldValidator(
  reportUrl,
  (value) => normalizeReportLink(value, location.origin),
  'link to report',
);
autoFormatField(reportUrl, formatUrl);
function checkReportConfirmation() {
  const message = reportConfirm.checked ? '' : 'confirm that this link contains abusive content.';
  reportConfirm.setCustomValidity(message);
  reportConfirm.setAttribute('aria-invalid', String(!!message));
  $('#report-confirm-error').textContent = message;
  $('#report-confirm-error').hidden = !message;
  return message;
}
$('#report-abuse').addEventListener('click', () => {
  if (busy) return;
  closeMenus();
  reportForm.reset();
  reportUrl.value = editing ? cardUrl(editing) : '';
  $('#report-error').textContent = '';
  reportDialog.showModal();
  reportUrl.focus();
});
reportUrl.addEventListener('input', () => {
  checkReportUrl();
  $('#report-error').textContent = '';
});
reportConfirm.addEventListener('change', checkReportConfirmation);
reportDialog.addEventListener('close', () => {
  reportForm.reset();
  for (const input of [reportUrl, reportConfirm]) {
    input.setCustomValidity('');
    input.removeAttribute('aria-invalid');
  }
  for (const id of ['report-url-error', 'report-confirm-error']) {
    $('#' + id).textContent = '';
    $('#' + id).hidden = true;
  }
  $('#report-error').textContent = '';
});
reportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const urlError = checkReportUrl(),
    confirmError = checkReportConfirmation();
  if (urlError || confirmError) {
    (urlError ? reportUrl : reportConfirm).focus();
    return;
  }
  setBusy(true);
  $('#send-report').textContent = 'sending…';
  $('#report-error').textContent = '';
  let sent = false;
  try {
    const link = normalizeReportLink(reportUrl.value, location.origin);
    await api('/api/reports', {
      method: 'POST',
      body: JSON.stringify({ url: link.url, confirmed: reportConfirm.checked }),
    });
    sent = true;
  } catch (error) {
    $('#report-error').textContent = error.message;
  } finally {
    setBusy(false);
    $('#send-report').textContent = 'send report';
  }
  if (sent) {
    reportDialog.close();
    toast('report sent. thank you.');
  }
});

$('#show-sign-in').addEventListener('click', () => {
  if (busy) return;
  closeMenus();
  $('#sign-in-error').textContent = '';
  $('#sign-in-dialog').showModal();
  $('#sign-in-token').focus();
});
$('#sign-in-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const result = await accountRequest('/api/login', { token: $('#sign-in-token').value.trim() });
  if (result) {
    $('#sign-in-token').value = '';
    authenticated = true;
    $('#sign-in-dialog').close();
    await refreshCards();
  }
  finishAuth();
  if (result && resumeEditor) {
    resumeEditor = false;
    showView('editor');
  } else if (result) $('#cards-heading').focus({ preventScroll: true });
});
$('#sign-in-dialog').addEventListener('close', () => {
  $('#sign-in-token').value = '';
});
$('#copy-token').addEventListener('click', () => copy(newToken));
$('#download-token').addEventListener('click', () => {
  if (busy || !newToken) return;
  const url = URL.createObjectURL(
    new Blob(
      [
        'linkbed access token\n' +
          newToken +
          '\n\nkeep private. sign in at ' +
          location.origin +
          '\n',
      ],
      { type: 'text/plain' },
    ),
  );
  const link = element('a');
  link.href = url;
  link.download = 'linkbed-access-token.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('#download-token').dataset.downloaded = 'true';
  $('#download-token').textContent = 'downloaded';
});
$('#finish-account').addEventListener('click', () => {
  if (!busy) $('#account-new-token').close();
});
$('#account-new-token').addEventListener('close', () => {
  newToken = '';
  $('#new-token').textContent = '';
  syncAccount();
  if (resumeEditor) {
    resumeEditor = false;
    showView('editor');
  } else $('#cards-heading').focus({ preventScroll: true });
});
$('#sign-out').addEventListener('click', async () => {
  if (busy || (dirty && !(await confirmAction('sign out and discard your draft?', 'sign out'))))
    return;
  const result = await accountRequest('/api/logout');
  if (result) {
    authenticated = false;
    reset(false);
    await refreshCards();
  }
  finishAuth();
});
window.addEventListener('pagehide', saveEditor);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveEditor();
});
window.addEventListener('beforeunload', (event) => {
  const saved = saveEditor();
  if ((dirty && !saved) || newToken || authBusy) {
    event.preventDefault();
    event.returnValue = '';
  }
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').setAttribute(
    'aria-label',
    'switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode',
  );
  $('#theme-toggle').replaceChildren(
    icon(theme === 'dark' ? 'sun' : 'moon'),
    element('span', theme === 'dark' ? 'light mode' : 'dark mode', 'nav-theme-label'),
  );
  Coloris({ themeMode: theme });
  if ($('emoji-picker')) $('emoji-picker').className = theme;
}
let theme;
try {
  theme = localStorage.getItem('theme');
} catch {}
applyTheme(theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#theme-toggle').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try {
    localStorage.setItem('theme', theme);
  } catch {}
});

function applyPreviewTheme(theme) {
  $('.discord-window').dataset.previewTheme = theme;
  document.querySelectorAll('.preview-themes button').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.previewTheme === theme));
  });
}
let previewTheme;
try {
  previewTheme = localStorage.getItem('preview-theme');
} catch {}
applyPreviewTheme(previewTheme === 'light' ? 'light' : 'dark');
document.querySelectorAll('.preview-themes button').forEach((button) => {
  button.addEventListener('click', () => {
    const theme = button.dataset.previewTheme;
    applyPreviewTheme(theme);
    try {
      localStorage.setItem('preview-theme', theme);
    } catch {}
  });
});

mountIcons();
syncNavigation();
reset(false);
const restored = restoreEditor();
setTab(restored?.tab === 'preview' ? 'preview' : 'edit');
showView(location.hash === '#cards' || restored?.view === 'cards' ? 'cards' : 'editor', false);
restoring = false;
if (Number.isFinite(restored?.scroll)) window.scrollTo(0, restored.scroll);
syncHeaderVisibility();
saveEditor();
syncAccount();
document.body.dataset.ready = '';
refreshCards();
