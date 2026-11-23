import {
  normalizeCard,
  normalizeComponent,
  normalizePageCard,
  isBadgeCase,
  selectedEmbedIndex,
  MAX_BADGES,
  normalizeSlug,
  normalizeColor,
  normalizeReportLink,
  normalizeReportReason,
  REPORT_REASONS,
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
  MAX_CARDS,
  MAX_PAGE_BYTES,
  PAGE_COLORS,
  cardComponents,
  seoMetadata,
} from './model.mts';
import {
  createComposer,
  renderComponent,
  fieldValidator,
  autoFormatField,
  collapseDragZone,
} from './components.mts';
import { importCardJson, messageJson, linkedEmbedCode } from './interchange.mts';
import { icon, mountIcons } from './icons.mts';
import type { Page, PageBadge, PageCard, PageColors, PageColorKey, PageTheme } from './model.mts';
import type { JsonEditor } from './code-editor.mts';
import Coloris from './vendor/coloris.mjs';
import Sortable from './vendor/sortable.mjs';

function $<T extends HTMLElement = HTMLElement>(
  selector: string,
  type?: { new (): T },
  root: ParentNode = document,
): T {
  const node = root.querySelector<T>(selector);
  if (!node || (type && !(node instanceof type)))
    throw new Error('missing editor element: ' + selector);
  return node;
}

type EditorCard = Partial<Page> & { sponsored?: boolean };
type SavedCard = Page & { slug: string; sponsored: boolean; badges: PageBadge[] };
type View = 'editor' | 'cards';
type EditorTab = 'edit' | 'preview';
type PreviewMode = 'discord' | 'page';
type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement;
type EditorError = { message: string; label?: string; input?: HTMLElement; cardIndex?: number };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'request failed.';
}

function pageTheme(value: unknown): PageTheme | undefined {
  return value === 'light' || value === 'dark' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasCardRoot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 17) return Array.isArray(value.components);
  return value.type === 'badge_case' && Array.isArray(value.badges);
}
const siteHeader = $('.site-header');
const siteNav = $('#site-nav'),
  navToggle = $('#nav-toggle', HTMLButtonElement);
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
  url: $('#source-url', HTMLInputElement),
  title: $('#title', HTMLInputElement),
  description: $('#description', HTMLTextAreaElement),
  color: $('#color', HTMLInputElement),
  slug: $('#slug', HTMLInputElement),
};
const seoFields = {
  title: $('#seo-title', HTMLInputElement),
  image: $('#seo-image', HTMLInputElement),
  favicon: $('#seo-favicon', HTMLInputElement),
};
const themes = ['light', 'dark'] as const;
const colorKeys = ['background', 'text', 'card', 'links', 'button', 'button_text'] as const;
const pageColorFields: Record<PageTheme, Map<PageColorKey, HTMLInputElement>> = {
  light: new Map(),
  dark: new Map(),
};
for (const mode of themes) {
  for (const name of colorKeys) {
    const value = PAGE_COLORS[mode][name];
    const label = element(
      'label',
      name === 'button_text' ? 'button text' : name === 'button' ? 'button background' : name,
    );
    const input = element('input');
    input.type = 'text';
    input.id = 'page-' + mode + '-' + name;
    input.className = 'page-palette-color';
    input.value = value;
    input.maxLength = 7;
    input.spellcheck = false;
    input.dataset.coloris = '';
    input.setAttribute('aria-label', mode + ' mode ' + name);
    autoFormatField(input, formatColor);
    const swatch = element('div', undefined, 'clr-field');
    const button = element('button');
    button.type = 'button';
    button.setAttribute('aria-label', 'choose ' + mode + ' ' + name);
    swatch.style.color = value;
    swatch.append(button, input);
    label.htmlFor = input.id;
    label.append(swatch);
    $('[data-palette="' + mode + '"]').append(label);
    pageColorFields[mode].set(name, input);
  }
}
let loading = false,
  jsonDirty = false,
  jsonEditor: JsonEditor | undefined;
const composer = createComposer($('#component-list'), () => {
  if (!loading) changed();
});
let editing: string | null = null,
  dirty = false,
  slugEdited = false,
  showErrors = false,
  usingTemplate = true,
  sponsored = false;
let restoring = true;
let pageCards: PageCard[] = [composer.get()],
  activeCard = 0,
  expandedCard: number | null = 0,
  embedCard: number | null = null,
  pageTools = false,
  previewMode: PreviewMode = 'discord';
let authenticated = false,
  newToken = '',
  busy = false,
  controls: [FormControl, boolean][] = [],
  refreshVersion = 0,
  toastTimer: number | undefined;
let resumeEditor = false,
  authBusy = false;

const mobile = matchMedia('(max-width: 760px)');
let mobileTab: EditorTab = 'edit';
Coloris.init();
Coloris({
  el: '#color, .page-palette-color',
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
    seoFields.favicon,
    (value) => (value.trim() ? httpsUrl(value.trim(), 'favicon url') : null),
    'favicon url',
  ),
  ...themes.flatMap((mode) =>
    Array.from(pageColorFields[mode], ([name, input]) =>
      fieldValidator(input, normalizeColor, mode + ' ' + name),
    ),
  ),
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
    seoFields.title,
    (value) => validateText(value, 'preview title', 256),
    'preview title',
  ),
  fieldValidator(
    seoFields.image,
    (value) => (value.trim() ? httpsUrl(value.trim(), 'preview image') : null),
    'preview image',
  ),
  fieldValidator(
    fields.color,
    (value) => normalizeColor($('#no-accent', HTMLInputElement).checked ? null : value),
    'accent color',
  ),
];
for (const input of [
  fields.url,
  seoFields.image,
  seoFields.favicon,
  $('#url-import-value', HTMLInputElement),
])
  autoFormatField(input, formatUrl);
autoFormatField(fields.color, formatColor);
autoFormatField(fields.slug, formatSlug);
const canonical = document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content;
const publicOrigin = new URL(canonical || location.origin).origin;
const publicHost = new URL(publicOrigin).host;
const cardUrl = (slug: string) => publicOrigin + '/' + slug;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function toast(message: string) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    $('#toast').hidden = true;
  }, 2400);
}

function confirmAction(message: string, label = 'continue') {
  const dialog = $('#confirm-dialog', HTMLDialogElement);
  if (busy || dialog.open) return Promise.resolve(false);
  $('#confirm-heading').textContent = message;
  $('#confirm-action', HTMLButtonElement).textContent = label;
  dialog.returnValue = 'cancel';
  return new Promise<boolean>((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {
      once: true,
    });
    dialog.showModal();
  });
}

function showView(view: View, focus = true) {
  if (busy) return;
  document.body.dataset.view = view;
  history.replaceState(null, '', view === 'cards' ? '#cards' : location.pathname + location.search);
  $('#cards-view').hidden = view !== 'cards';
  $('#editor-view').hidden = view !== 'editor';
  $('#show-cards', HTMLAnchorElement).setAttribute(
    'aria-current',
    view === 'cards' ? 'page' : 'false',
  );
  if (focus)
    (view === 'cards' ? $('#cards-heading') : $('#editor-heading')).focus({ preventScroll: true });
  window.scrollTo(0, 0);
  syncHeaderVisibility();
  saveEditor();
}

function setTab(tab: EditorTab) {
  mobileTab = tab;
  const target = mobile.matches ? $('#mobile-actions-menu') : $('.toolbar-actions');
  if ($('#edit-json', HTMLButtonElement).parentElement !== target) {
    closeMenus();
    if (mobile.matches)
      target.append(
        $('#edit-json', HTMLButtonElement),
        $('#export-toggle', HTMLButtonElement),
        $('#show-embed', HTMLButtonElement),
      );
    else
      target.prepend(
        $('#edit-json', HTMLButtonElement),
        $('#export-toggle', HTMLButtonElement),
        $('#show-embed', HTMLButtonElement),
      );
  }
  for (const name of ['edit', 'preview'] as const) {
    const button = $('#' + name + '-tab');
    button.setAttribute('aria-selected', String(tab === name));
    button.tabIndex = tab === name ? 0 : -1;
  }
  $('#card-form', HTMLFormElement).hidden = mobile.matches && tab !== 'edit';
  $('#live-preview').hidden = mobile.matches && tab !== 'preview';
  for (const panel of [$('#card-form', HTMLFormElement), $('#live-preview')]) {
    if (mobile.matches) panel.setAttribute('role', 'tabpanel');
    else panel.removeAttribute('role');
  }
  saveEditor();
}
for (const name of ['edit', 'preview'] as const)
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
  if (event.target instanceof Element && event.target.closest('a, button')) closeMenus();
});
mobile.addEventListener('change', () => {
  setTab(mobileTab);
  syncNavigation();
});

function setBusy(value: boolean) {
  busy = value;
  $('#card-form', HTMLFormElement).inert = value;
  if (value) {
    Coloris.close();
    controls = [...document.querySelectorAll<FormControl>('input, textarea, button, select')].map(
      (control) => [control, control.disabled],
    );
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
  $('#json-panel', HTMLDialogElement).inert = value;
  $('#account-panel').setAttribute('aria-busy', String(value));
  $('#sign-in-dialog', HTMLDialogElement).setAttribute('aria-busy', String(value));
  $('#report-dialog', HTMLDialogElement).setAttribute('aria-busy', String(value));
  $('#publish-dialog', HTMLDialogElement).setAttribute('aria-busy', String(value));
  $('#account-new-token', HTMLDialogElement).setAttribute('aria-busy', String(value));
  $('#card-form', HTMLFormElement).setAttribute('aria-busy', String(value));
}

function slugify(value: string) {
  return formatSlug(value);
}

function draft() {
  pageCards[activeCard] = composer.get();
  const seo = Object.fromEntries(
    Object.entries(seoFields)
      .map(([name, input]) => [name, input.value.trim()])
      .filter(([, value]) => value),
  );
  const pageColors: PageColors = {};
  for (const mode of themes) {
    const overrides = Object.fromEntries(
      [...pageColorFields[mode]]
        .filter(([name, input]) => input.value !== PAGE_COLORS[mode][name])
        .map(([name, input]) => [name, input.value]),
    );
    if (Object.keys(overrides).length) pageColors[mode] = overrides;
  }
  const theme = pageTheme($('#page-theme', HTMLSelectElement).value);
  const colorScheme = pageTheme($('#page-color-scheme', HTMLSelectElement).value);
  const previewCard =
    pageCards[
      selectedEmbedIndex({
        component: pageCards[0],
        additional_cards: pageCards.slice(1),
        embed_card: embedCard,
      })
    ];
  return {
    title: fields.title.value.trim(),
    description: fields.description.value.trim(),
    url: fields.url.value.trim() || null,
    color:
      previewCard?.accent_color == null
        ? null
        : '#' + previewCard.accent_color.toString(16).padStart(6, '0'),
    component: pageCards[0],
    ...(!$('#show-sponsor', HTMLInputElement).checked ? { sponsor_hidden: true } : {}),
    ...(theme ? { page_theme: theme } : {}),
    ...(colorScheme ? { page_color_scheme: colorScheme } : {}),
    ...(Object.keys(pageColors).length ? { page_colors: pageColors } : {}),
    ...(pageCards.length > 1 ? { additional_cards: pageCards.slice(1) } : {}),
    ...(embedCard !== null ? { embed_card: embedCard } : {}),
    ...(Object.keys(seo).length ? { seo } : {}),
  };
}

function selectPageCard(index: number, save = true, expand = true) {
  if (save) pageCards[activeCard] = composer.get();
  activeCard = index;
  expandedCard = expand ? index : null;
  loading = true;
  const component = pageCards[index];
  fields.color.value = '#' + (component.accent_color ?? 0x5865f2).toString(16).padStart(6, '0');
  $('#no-accent', HTMLInputElement).checked = component.accent_color == null;
  $('#card-spoiler', HTMLInputElement).checked = !!component.spoiler;
  composer.set(component);
  loading = false;
  update();
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
        embedMode: $('#embed-mode', HTMLSelectElement).value,
        previewMode,
        activeCard,
        expandedCard,
        pageTools,
        sponsored,
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
              json: jsonDirty ? $('#component-json', HTMLTextAreaElement).value : null,
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
    const state: unknown = JSON.parse(sessionStorage.getItem('linkbed-editor') ?? 'null');
    if (!isRecord(state) || location.hash === '#new') return null;
    const saved = state.draft;
    if (saved) {
      if (!isRecord(saved) || !isRecord(saved.card)) return null;
      const { card } = saved;
      const additional = card.additional_cards;
      if (
        !hasCardRoot(card.component) ||
        (additional !== undefined &&
          (!Array.isArray(additional) ||
            additional.length >= MAX_CARDS ||
            !additional.every(hasCardRoot))) ||
        typeof card.url !== 'string' ||
        typeof card.title !== 'string' ||
        typeof card.description !== 'string' ||
        typeof saved.slug !== 'string' ||
        typeof saved.color !== 'string' ||
        (saved.editing !== null && typeof saved.editing !== 'string')
      )
        return null;
      usingTemplate = false;
      // Preserve unfinished values from saveEditor so the user can fix them before publishing.
      fill(card as EditorCard, saved.slug);
      if (
        typeof state.activeCard === 'number' &&
        Number.isInteger(state.activeCard) &&
        state.activeCard >= 0 &&
        state.activeCard < pageCards.length
      )
        selectPageCard(state.activeCard);
      fields.color.value = saved.color;
      editing = saved.editing;
      dirty = !!saved.dirty;
      slugEdited = !!saved.slugEdited;
      if (typeof saved.json === 'string') {
        jsonDirty = true;
        $('#component-json', HTMLTextAreaElement).value = saved.json;
      }
    }
    if (state.expandedCard === null) expandedCard = null;
    pageTools = state.pageTools === undefined ? pageCards.length > 1 : !!state.pageTools;
    showErrors = !!state.showErrors;
    sponsored = !!state.sponsored;
    previewMode = state.previewMode === 'page' ? 'page' : 'discord';
    $('#embed-mode', HTMLSelectElement).value = state.embedMode === 'live' ? 'live' : 'snapshot';
    update();
    return state;
  } catch {
    reset(false);
    return null;
  }
}

function update() {
  const card = draft();
  const roots = cardComponents(card);
  const current = roots[activeCard];
  const multiple = roots.length > 1;
  const pagePreview = previewMode === 'page' && (!card.url || pageTools);
  $('#delete-card', HTMLButtonElement).hidden = !editing;
  $('#perk-management').hidden = !sponsored;
  const previewRoot = buildEmbed(card).component;
  if (previewRoot) renderComponent($('#preview-card'), previewRoot);
  else $('#preview-card').replaceChildren();
  $('#enable-page-tools', HTMLInputElement).checked = pageTools;
  $('#page-management-controls').hidden = !pageTools;
  $('#page-link-warning').hidden = !card.url;
  $('.page-appearance').hidden = !pageTools;
  $('#reset-page-appearance', HTMLButtonElement).disabled =
    busy || !(card.page_theme || card.page_colors || card.page_color_scheme);
  for (const mode of themes) {
    const fieldset = $('[data-palette="' + mode + '"]').closest('fieldset');
    if (fieldset) fieldset.hidden = !!card.page_color_scheme && card.page_color_scheme !== mode;
  }
  fields.url.disabled = busy;
  $('#destination-hint').textContent = 'leave blank to keep visitors on this page.';
  $('#page-card-actions').hidden = !pageTools;
  $('#add-page-card', HTMLButtonElement).hidden = !pageTools;
  for (const button of ['#add-page-card', '#add-badge-case'])
    $(button, HTMLButtonElement).disabled = busy || jsonDirty || roots.length >= MAX_CARDS;
  for (const selector of ['.add-component-heading', '.add-component', '.templates'])
    $('#page-card-fields ' + selector).hidden = isBadgeCase(current);
  $('#preview-scope').hidden = !!card.url && !pageTools;
  $('#discord-preview-message').hidden = pagePreview;
  $('#page-preview-cards').hidden = !pagePreview;
  $('.discord-window').classList.toggle('is-page-preview', pagePreview);
  $('#preview-heading').textContent = pagePreview ? 'your page' : 'showcase';
  document.querySelectorAll<HTMLButtonElement>('[data-preview-mode]').forEach((button) => {
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.previewMode === (pagePreview ? 'page' : 'discord')),
    );
  });
  if (pagePreview) {
    $('#page-preview-cards').replaceChildren(
      ...roots.map((root) => {
        const preview = element('article', undefined, 'discord-card');
        renderComponent(preview, root);
        return preview;
      }),
    );
  }
  syncPagePreview(card, pagePreview);
  renderCardEditors();
  for (const mode of themes) {
    for (const [name, input] of pageColorFields[mode]) {
      if (input.parentElement)
        input.parentElement.style.color = /^#[0-9a-f]{6}$/i.test(input.value)
          ? input.value
          : PAGE_COLORS[mode][name];
    }
  }
  const metadata = seoMetadata(card);
  seoFields.title.placeholder = card.title || 'use card name';
  const generatedMetadata = seoMetadata({ ...card, seo: undefined, description: '' });
  fields.description.placeholder = generatedMetadata.description || 'use preview card text';
  seoFields.image.placeholder = generatedMetadata.image || 'use preview card image';
  $('#reset-seo', HTMLButtonElement).disabled =
    busy || !(Object.values(seoFields).some((input) => input.value) || fields.description.value);
  $('#seo-preview-title').textContent = metadata.title || 'your page';
  $('#seo-preview-description').textContent = metadata.description;
  $('#seo-preview-host').textContent = publicHost + '/' + (fields.slug.value || 'your-card');
  const previewImage = $('#seo-preview-image', HTMLImageElement);
  previewImage.hidden = !metadata.image;
  if (metadata.image && previewImage.getAttribute('src') !== metadata.image)
    previewImage.src = metadata.image;
  if (!metadata.image) previewImage.removeAttribute('src');
  const favicon = $('#seo-preview-icon', HTMLImageElement);
  favicon.hidden = !card.seo?.favicon;
  if (card.seo?.favicon && favicon.getAttribute('src') !== card.seo.favicon)
    favicon.src = card.seo.favicon;
  if (!card.seo?.favicon) favicon.removeAttribute('src');
  const stats = componentStats(current);
  $('#page-card-fields .content-heading h3').textContent = 'content';
  $('#component-count').textContent = isBadgeCase(current)
    ? current.badges.length + ' / ' + MAX_BADGES + ' badges'
    : (multiple ? 'card ' + (activeCard + 1) + ' · ' : '') +
      stats.components +
      ' / 40 · ' +
      stats.media +
      ' / 10 media';
  $('#add-component', HTMLButtonElement).disabled = busy || stats.components >= 40;
  $('#preview-url').textContent = publicHost + '/' + (fields.slug.value || 'your-card');
  $('#slug-prefix').textContent = publicHost + '/';
  $('#slug-hint').textContent =
    editing && fields.slug.value !== editing ? 'old link stops working after save.' : '';
  const bytes = payloadBytes({
    component: pagePreview && !isBadgeCase(current) ? current : previewRoot,
  });
  $('#byte-count').textContent =
    pagePreview && isBadgeCase(current) ? 'page only' : bytes.toLocaleString() + ' / 3,000 bytes';
  $('#byte-count').classList.toggle('over-limit', bytes > MAX_BYTES);
  const errors = validateEditor(card);
  $('#publish-button', HTMLButtonElement).disabled = busy || jsonDirty;
  if (!busy) $('#publish-label').textContent = editing ? 'save changes' : 'publish';
  fields.color.disabled = busy || $('#no-accent', HTMLInputElement).checked;
  const colorSwatch = fields.color.parentElement;
  const colorButton = colorSwatch?.querySelector('button');
  if (colorButton) colorButton.disabled = fields.color.disabled;
  if (colorSwatch) colorSwatch.style.color = fields.color.value;
  const live = $('#embed-mode', HTMLSelectElement).value === 'live';
  let embedReady =
    !errors.some(({ input }) => !input || input.closest('#component-list')) && !jsonDirty;
  $('#embed-code', HTMLTextAreaElement).value = live ? '' : embedScript(card);
  $('#embed-code', HTMLTextAreaElement).rows = live ? 3 : 8;
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
        $('#embed-code', HTMLTextAreaElement).value = code.head;
        $('#embed-route', HTMLTextAreaElement).value = code.route;
      } catch (error) {
        embedReady = false;
        $('#embed-hint').textContent = errorMessage(error);
      }
    }
  }
  $('#embed-code', HTMLTextAreaElement).hidden = live && !embedReady;
  $('#embed-live').hidden = !live || !embedReady;
  $('#copy-code', HTMLButtonElement).disabled = busy || !embedReady;
  $('#copy-route', HTMLButtonElement).disabled = busy || !embedReady;
  $('#copy-prompt', HTMLButtonElement).disabled = busy || !embedReady;
  if (!jsonDirty) {
    const value = JSON.stringify(
      {
        component: card.component,
        ...(card.additional_cards ? { additional_cards: card.additional_cards } : {}),
        ...(card.embed_card !== undefined ? { embed_card: card.embed_card } : {}),
        ...(card.seo ? { seo: card.seo } : {}),
        ...(card.page_theme ? { page_theme: card.page_theme } : {}),
        ...(card.page_colors ? { page_colors: card.page_colors } : {}),
        ...(card.page_color_scheme ? { page_color_scheme: card.page_color_scheme } : {}),
      },
      null,
      2,
    );
    $('#component-json', HTMLTextAreaElement).value = value;
    jsonEditor?.set(value);
  }
  $('#editor-notice').hidden = !editing && !dirty && !usingTemplate;
  $('#copy-card-link', HTMLButtonElement).hidden = !editing;
  $('#copy-card-link', HTMLButtonElement).disabled = busy;
  $('#clear-template', HTMLButtonElement).textContent =
    editing || dirty ? 'clear changes' : 'clear template';
  $('#clear-template', HTMLButtonElement).disabled = busy;
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
  const componentErrors: EditorError[] = composer.validate(showErrors);
  const errors: EditorError[] = [
    ...fieldChecks.map((check) => check(showErrors)).filter((error) => error != null),
    ...componentErrors.map((error) => ({
      ...error,
      label: pageCards.length > 1 ? 'card ' + (activeCard + 1) + ', ' + error.label : error.label,
    })),
  ];
  const roots = cardComponents(card);
  roots.forEach((component, index) => {
    if (index === activeCard && componentErrors.length) return;
    try {
      normalizePageCard(component);
    } catch (invalid) {
      errors.push({
        message: errorMessage(invalid),
        ...(roots.length > 1 ? { label: 'card ' + (index + 1), cardIndex: index } : {}),
      });
    }
  });
  if (roots.length > MAX_CARDS) errors.push({ message: `use up to ${MAX_CARDS} cards per page.` });
  const stats = componentStats(roots[activeCard]);
  const limits: [boolean, string][] = [
    [stats.components > 40, 'use up to 40 components.'],
    [stats.media > 10, 'use up to ten gallery items across the embed.'],
    [
      !isBadgeCase(roots[activeCard]) && payloadBytes({ component: roots[activeCard] }) > MAX_BYTES,
      'card exceeds discord’s 3,000-byte limit. shorten text or remove a link or image.',
    ],
  ];
  for (const [invalid, message] of limits) {
    if (invalid && !errors.some((error) => error.message === message)) errors.push({ message });
  }
  if (jsonDirty) errors.push({ message: 'apply json before publishing.' });
  const visibleErrors = showErrors ? errors : [];
  $('#validation-list').replaceChildren(
    ...visibleErrors.map(({ input, label, message, cardIndex }) => {
      const row = element('li');
      const link = element(
        input || cardIndex !== undefined ? 'a' : 'span',
        label ? label + ': ' + message : message,
      );
      if (link instanceof HTMLAnchorElement) {
        link.href = '#' + (input?.id || 'page-card-fields');
        link.addEventListener('click', (event) => {
          event.preventDefault();
          setTab('edit');
          if (cardIndex !== undefined) {
            selectPageCard(cardIndex);
            $('#page-card-editors [data-index="' + cardIndex + '"] [data-action="toggle"]').focus();
            return;
          }
          if (!input) return;
          for (let parent = input.parentElement; parent; parent = parent.parentElement) {
            if (parent instanceof HTMLDetailsElement) parent.open = true;
            if (parent.matches('.component-editor[data-collapsed]'))
              parent.querySelector<HTMLButtonElement>('.block-toggle')?.click();
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

function fill(card: EditorCard, slug = '') {
  loading = true;
  sponsored = card.sponsored === true;
  $('#show-sponsor', HTMLInputElement).checked = !card.sponsor_hidden;
  for (const name of ['url', 'title', 'description'] as const)
    fields[name].value = card[name] ?? '';
  for (const name of ['title', 'image', 'favicon'] as const)
    seoFields[name].value = card.seo?.[name] ?? '';
  $('#page-theme', HTMLSelectElement).value = card.page_theme || 'auto';
  $('#page-color-scheme', HTMLSelectElement).value = card.page_color_scheme || 'auto';
  for (const mode of themes)
    for (const [name, input] of pageColorFields[mode])
      input.value = card.page_colors?.[mode]?.[name] || PAGE_COLORS[mode][name];
  pageCards = cardComponents({
    title: '',
    description: '',
    color: null,
    url: null,
    images: [],
    buttons: [],
    ...card,
  });
  const component = pageCards[0];
  embedCard =
    typeof card.embed_card === 'number' &&
    Number.isInteger(card.embed_card) &&
    card.embed_card >= 0 &&
    card.embed_card < pageCards.length &&
    !isBadgeCase(pageCards[card.embed_card])
      ? card.embed_card
      : null;
  activeCard = 0;
  expandedCard = 0;
  pageTools =
    pageCards.length > 1 || !!card.page_theme || !!card.page_colors || !!card.page_color_scheme;
  previewMode = pageCards.length > 1 ? 'page' : 'discord';
  fields.color.value = '#' + (component.accent_color ?? 0x5865f2).toString(16).padStart(6, '0');
  $('#no-accent', HTMLInputElement).checked = component.accent_color == null;
  $('#card-spoiler', HTMLInputElement).checked = !!component.spoiler;
  fields.slug.value = slug;
  fields.slug.disabled = busy;
  composer.set(component);
  showErrors = false;
  jsonDirty = false;
  $('#json-error').textContent = '';
  loading = false;
  update();
}

async function withSessionLock<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('update your browser to save cards safely.');
  return navigator.locks.request('linkbed-session', work);
}

async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = isRecord(data) && typeof data.error === 'string' && data.error;
    throw new Error(message || 'request failed.');
  }
  return data;
}

function readSession(value: unknown): { authenticated: boolean; guest: boolean } {
  if (!isRecord(value)) throw new Error('invalid session response.');
  return { authenticated: value.authenticated === true, guest: value.guest === true };
}

function readEditorCard(value: unknown): Page {
  if (!isRecord(value) || typeof value.title !== 'string') throw new Error('invalid card data.');
  const { component, additional_cards: additional, buttons, images } = value;
  if (
    (component !== undefined && !hasCardRoot(component)) ||
    (additional !== undefined && (!Array.isArray(additional) || !additional.every(hasCardRoot))) ||
    (images !== undefined &&
      (!Array.isArray(images) || images.some((image) => typeof image !== 'string'))) ||
    (buttons !== undefined &&
      (!Array.isArray(buttons) ||
        buttons.some(
          (button) =>
            !isRecord(button) || typeof button.label !== 'string' || typeof button.url !== 'string',
        )))
  )
    throw new Error('invalid card data.');
  // Keep values from previous saves and imports so users can edit them before write validation.
  const card = value as EditorCard;
  return {
    description: '',
    url: null,
    color: null,
    buttons: [],
    images: [],
    ...card,
    title: value.title,
  };
}

function readSavedCard(value: unknown): SavedCard {
  if (!isRecord(value) || typeof value.slug !== 'string')
    throw new Error('invalid saved card response.');
  const badges: PageBadge[] = [];
  const badgeRows: unknown[] = Array.isArray(value.badges) ? value.badges : [];
  for (const badge of badgeRows) {
    if (!isRecord(badge)) continue;
    if (badge.name === 'verified' && badge.icon === 'badge-check')
      badges.push({ name: 'verified', icon: 'badge-check' });
    else if (badge.name === 'sponsor' && badge.icon === 'heart')
      badges.push({ name: 'sponsor', icon: 'heart' });
    else if (typeof badge.name === 'string' && typeof badge.image === 'string')
      badges.push({ name: badge.name, image: badge.image });
  }
  return {
    ...readEditorCard(value),
    slug: value.slug,
    sponsored: value.sponsored === true,
    badges,
  };
}

function syncAccount() {
  $('#guest-notice').hidden = authenticated;
  $('#token-notice').hidden = !authenticated;
  $('#publish-token-prompt').hidden = authenticated;
  if (newToken && !$('#account-new-token', HTMLDialogElement).open)
    $('#account-new-token', HTMLDialogElement).showModal();
  $('#sign-out', HTMLButtonElement).hidden = !authenticated || !!newToken;
  $('#saved-cards').hidden = false;
}

async function openCard(card: SavedCard) {
  if (busy || (dirty && !(await confirmAction('discard unsaved changes?', 'discard')))) return;
  editing = card.slug;
  usingTemplate = false;
  slugEdited = true;
  dirty = false;
  fill(card, card.slug);
  setTab('edit');
  showView('editor');
}

async function deleteCard(slug: string, errorNode: HTMLElement) {
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
    errorNode.textContent = errorMessage(error);
  } finally {
    setBusy(false);
  }
}

const savedCardPlural = new Intl.PluralRules('en');

async function refreshCards(initial?: unknown) {
  const version = ++refreshVersion;
  try {
    const bootstrap = isRecord(initial) ? initial : undefined;
    const session = readSession(bootstrap ?? (await api('/api/session')));
    const items = bootstrap?.cards ?? (await api('/api/cards'));
    if (version !== refreshVersion) return;
    if (!Array.isArray(items)) throw new Error('invalid cards response.');
    const cards = items.map(readSavedCard);
    authenticated = session.authenticated;
    if (editing) {
      sponsored = cards.find((card) => card.slug === editing)?.sponsored === true;
      update();
    }
    syncAccount();
    const count = cards.length;
    const noun = savedCardPlural.select(count) === 'one' ? 'card' : 'cards';
    $('#card-count').textContent = `${count} saved ${noun}`;
    $('#saved-list').replaceChildren(
      ...cards.map((card) => {
        const tile = element('article', undefined, 'saved-card');
        const open = element('button', undefined, 'saved-preview');
        open.type = 'button';
        open.setAttribute('aria-label', 'edit card: ' + card.title);
        const preview = element('div', undefined, 'discord-card');
        const root = buildEmbed(card).component;
        if (root) renderComponent(preview, root);
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
        url.append(element('span', '/' + card.slug, 'saved-url-label'));
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
        const link = element('div', undefined, 'saved-link');
        link.append(url);
        for (const badge of card.badges || []) {
          const tag = element('span', undefined, 'saved-badge');
          tag.title = badge.name;
          tag.setAttribute('role', 'img');
          tag.setAttribute('aria-label', badge.name);
          if (badge.icon) {
            tag.append(icon(badge.icon));
          } else {
            const image = element('img');
            image.src = badge.image;
            image.alt = '';
            image.width = image.height = 16;
            image.referrerPolicy = 'no-referrer';
            tag.append(image);
          }
          link.append(tag);
        }
        footer.append(link, copyLink, remove);
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
    if (version === refreshVersion) $('#account-error').textContent = errorMessage(error);
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
  const starter = document.querySelector('#starter-card')?.textContent;
  fill(
    starter
      ? readEditorCard(JSON.parse(starter))
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
  .querySelectorAll<HTMLAnchorElement>('.site-header a[href="#new"], .site-header a[href="#cards"]')
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
    const card: EditorCard = editing
      ? readSavedCard(await api('/api/cards/' + editing))
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
    $('#form-status').textContent = errorMessage(error);
  } finally {
    setBusy(false);
  }
}
$('#reset', HTMLButtonElement).addEventListener('click', clearChanges);
$('#clear-template', HTMLButtonElement).addEventListener('click', clearChanges);
$('#copy-card-link', HTMLButtonElement).addEventListener('click', () => {
  if (editing) void copy(cardUrl(editing));
});
$('#delete-card', HTMLButtonElement).addEventListener('click', () => {
  if (editing) deleteCard(editing, $('#form-status'));
});
for (const type of ['focusin', 'click', 'input', 'change'])
  $('#card-form', HTMLFormElement).addEventListener(type, (event) => {
    if (
      loading ||
      showErrors ||
      (event.target instanceof Element &&
        event.target.closest(
          '#editor-notice, #reset, #enable-page-tools, #page-management-controls',
        ))
    )
      return;
    showErrors = true;
    update();
  });
$('#card-form', HTMLFormElement).addEventListener('input', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLElement)) return;
  if (
    input.closest(
      '#component-list, .json-panel, #page-management-controls, #enable-page-tools, .page-appearance',
    )
  )
    return;
  if (input === fields.slug) slugEdited = true;
  if (input === fields.title && !editing && !slugEdited)
    fields.slug.value = slugify(fields.title.value);
  if (input === fields.color || input.id === 'no-accent') {
    if ($('#no-accent', HTMLInputElement).checked) {
      Coloris.close();
      composer.color(null);
    } else if (/^#[0-9a-f]{6}$/i.test(fields.color.value)) composer.color(fields.color.value);
    else changed();
  } else if (input instanceof HTMLInputElement && input.id === 'card-spoiler')
    composer.spoiler(input.checked);
  else changed();
});
$('.page-appearance').addEventListener('input', changed);
$('#page-theme', HTMLSelectElement).addEventListener('change', changed);
$('#page-color-scheme', HTMLSelectElement).addEventListener('change', changed);
$('#reset-page-appearance', HTMLButtonElement).addEventListener('click', () => {
  if (busy) return;
  $('#page-theme', HTMLSelectElement).value = 'auto';
  $('#page-color-scheme', HTMLSelectElement).value = 'auto';
  for (const mode of themes)
    for (const [name, input] of pageColorFields[mode]) input.value = PAGE_COLORS[mode][name];
  changed();
});
$('#reset-seo', HTMLButtonElement).addEventListener('click', () => {
  if (busy) return;
  for (const input of Object.values(seoFields)) input.value = '';
  fields.description.value = '';
  changed();
});
$('#enable-page-tools', HTMLInputElement).addEventListener('change', () => {
  pageTools = $('#enable-page-tools', HTMLInputElement).checked;
  update();
});
$('#add-badge-case', HTMLButtonElement).addEventListener('click', () => {
  if (busy || jsonDirty || pageCards.length >= MAX_CARDS) return;
  draft();
  pageCards.push({ type: 'badge_case', title: 'badge case', badges: [{ image: '' }] });
  previewMode = 'page';
  selectPageCard(pageCards.length - 1, false);
  changed();
  document
    .querySelector<HTMLInputElement>('#component-list input[type="url"]')
    ?.focus({ preventScroll: true });
});
$('#add-page-card', HTMLButtonElement).addEventListener('click', () => {
  if (busy || jsonDirty || pageCards.length >= MAX_CARDS) return;
  draft();
  pageCards.push({
    type: 17,
    accent_color: pageCards[activeCard].accent_color ?? null,
    components: [{ type: 10, content: '## new card' }],
  });
  previewMode = 'page';
  selectPageCard(pageCards.length - 1, false);
  changed();
  document
    .querySelector<HTMLTextAreaElement>('#component-list textarea')
    ?.focus({ preventScroll: true });
});
function movePageCard(from: number, to: number) {
  if (busy || jsonDirty || from === to || to < 0 || to >= pageCards.length) return;
  draft();
  const active = pageCards[activeCard];
  const chosen = embedCard === null ? null : pageCards[embedCard];
  pageCards.splice(to, 0, pageCards.splice(from, 1)[0]);
  embedCard = chosen ? pageCards.indexOf(chosen) : null;
  selectPageCard(pageCards.indexOf(active), false, expandedCard !== null);
  changed();
  $('#cards-status').textContent = 'moved to position ' + (to + 1) + '.';
}
function duplicatePageCard(index: number) {
  if (busy || jsonDirty || pageCards.length >= MAX_CARDS) return;
  draft();
  pageCards.splice(index + 1, 0, structuredClone(pageCards[index]));
  if (embedCard !== null && embedCard > index) embedCard++;
  previewMode = 'page';
  selectPageCard(index + 1, false);
  changed();
}
async function removePageCard(index: number) {
  if (
    busy ||
    jsonDirty ||
    pageCards.length < 2 ||
    (!isBadgeCase(pageCards[index]) &&
      pageCards.filter((card) => !isBadgeCase(card)).length === 1) ||
    !(await confirmAction('remove card ' + (index + 1) + '?', 'remove card'))
  )
    return;
  draft();
  pageCards.splice(index, 1);
  if (embedCard === index) embedCard = null;
  else if (embedCard !== null && embedCard > index) embedCard--;
  const next = activeCard > index ? activeCard - 1 : Math.min(activeCard, pageCards.length - 1);
  selectPageCard(next, false);
  changed();
}
function cardLabel(root: PageCard, index: number) {
  if (isBadgeCase(root)) return (root.title || 'badge case') + ' · page only';
  return (
    root.components
      .flatMap((block) => (block.type === 9 ? block.components : [block]))
      .find((block) => block.type === 10)
      ?.content.split('\n')[0]
      .replace(/^#+\s*/, '')
      .slice(0, 80) || 'card ' + (index + 1)
  );
}
function renderCardEditors() {
  const list = $('#page-card-editors');
  const fields = $('#page-card-fields');
  const choice = $('#embed-card-choice', HTMLSelectElement);
  pageCards.forEach((root, index) => {
    let card = list.querySelector<HTMLElement>(':scope > [data-index="' + index + '"]');
    if (!card) {
      card =
        index === 0
          ? $(':scope > .card-editor', HTMLElement, list)
          : element('section', undefined, 'form-section card-editor');
      card.dataset.index = String(index);
      card.querySelector(':scope > .card-titlebar')?.remove();
      const header = element('div', undefined, 'card-titlebar page-card-header');
      const action = (name: string, label: string, run: () => void, cls = 'text-button') => {
        const button = element('button', undefined, cls);
        button.type = 'button';
        button.append(icon(name));
        button.dataset.action = name;
        button.setAttribute('aria-label', label + ' card ' + (index + 1));
        button.title = label + ' card ' + (index + 1);
        button.addEventListener('click', run);
        return button;
      };
      const grip = action('grip-vertical', 'reorder', () => {}, 'drag-handle card-handle');
      grip.title = 'drag to reorder; use up and down arrow keys';
      grip.addEventListener('keydown', (event) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const to =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? pageCards.length - 1
              : index + (event.key === 'ArrowUp' ? -1 : 1);
        movePageCard(index, to);
        list.children[Math.max(0, Math.min(to, pageCards.length - 1))]
          ?.querySelector<HTMLButtonElement>('.card-handle')
          ?.focus();
      });
      const heading = element('h2', undefined, 'block-title');
      heading.id = 'page-card-heading-' + index;
      const toggle = element('button', undefined, 'block-toggle');
      toggle.type = 'button';
      toggle.dataset.action = 'toggle';
      toggle.setAttribute('aria-controls', 'page-card-body-' + index);
      toggle.append(element('span', undefined, 'page-card-name'), icon('chevron-down'));
      toggle.addEventListener('click', () => {
        if (busy || jsonDirty) return;
        if (expandedCard === index) {
          expandedCard = null;
          update();
        } else selectPageCard(index);
      });
      heading.append(toggle);
      const actions = element('div', undefined, 'block-actions');
      actions.append(
        action('arrow-up', 'move up', () => movePageCard(index, index - 1)),
        action('arrow-down', 'move down', () => movePageCard(index, index + 1)),
        action('copy', 'duplicate', () => duplicatePageCard(index)),
        action('trash-2', 'remove', () => removePageCard(index)),
      );
      header.append(grip, heading, actions);
      const body = element('div', undefined, 'page-card-body');
      body.id = 'page-card-body-' + index;
      card.prepend(header);
      card.append(body);
      card.setAttribute('aria-labelledby', heading.id);
    }
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
    const open = expandedCard === index;
    card.toggleAttribute('data-collapsed', !open);
    const body = $('.page-card-body', HTMLDivElement, card);
    body.hidden = !open;
    const toggle = $('[data-action="toggle"]', HTMLButtonElement, card);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.disabled = busy || jsonDirty;
    const label = 'card ' + (index + 1) + ' · ' + cardLabel(root, index);
    const nameLabel = $('.page-card-name', HTMLSpanElement, card);
    nameLabel.textContent = label;
    nameLabel.title = label;
    const handle = $('.card-handle', HTMLButtonElement, card);
    handle.hidden = !pageTools;
    handle.disabled = busy || jsonDirty || pageCards.length < 2;
    $('.block-actions', HTMLDivElement, card).hidden = !pageTools;
    const actionStates: [string, boolean][] = [
      ['arrow-up', index === 0],
      ['arrow-down', index === pageCards.length - 1],
      ['copy', pageCards.length >= MAX_CARDS],
      [
        'trash-2',
        pageCards.length < 2 ||
          (!isBadgeCase(root) && pageCards.filter((card) => !isBadgeCase(card)).length === 1),
      ],
    ];
    for (const [name, disabled] of actionStates)
      $('[data-action="' + name + '"]', HTMLButtonElement, card).disabled =
        busy || jsonDirty || disabled;
    if (index === activeCard && fields.parentElement !== body) body.append(fields);
  });
  while (list.children.length > pageCards.length) list.lastElementChild?.remove();
  const first = pageCards.findIndex((card) => !isBadgeCase(card));
  choice.replaceChildren(
    new Option(first > 0 ? 'automatic · card ' + (first + 1) : 'automatic · first card', 'auto'),
  );
  pageCards.forEach((root, index) => {
    if (!isBadgeCase(root))
      choice.add(new Option('card ' + (index + 1) + ' · ' + cardLabel(root, index), String(index)));
  });
  choice.value = embedCard === null ? 'auto' : String(embedCard);
  choice.disabled = busy || jsonDirty;
  fields.setAttribute('aria-labelledby', 'page-card-heading-' + activeCard);
}
$('#embed-card-choice', HTMLSelectElement).addEventListener('change', () => {
  const value = $('#embed-card-choice', HTMLSelectElement).value;
  embedCard = value === 'auto' ? null : Number(value);
  changed();
});
new Sortable($('#page-card-editors'), {
  draggable: '.card-editor',
  handle: '.card-handle',
  ...collapseDragZone($('#page-card-editors'), '.card-editor'),
  animation: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 91,
  ghostClass: 'reorder-placeholder',
  chosenClass: 'reorder-chosen',
  forceFallback: true,
  fallbackTolerance: 4,
  onEnd: ({ oldIndex, newIndex }) => {
    if (oldIndex !== undefined && newIndex !== undefined) movePageCard(oldIndex, newIndex);
  },
});

document.querySelectorAll<HTMLButtonElement>('[data-preview-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    const mode = button.dataset.previewMode;
    if (mode !== 'discord' && mode !== 'page') return;
    previewMode = mode;
    update();
  });
});
$('#add-component', HTMLButtonElement).addEventListener('click', () => {
  if (busy) return;
  composer.add($('#component-type', HTMLSelectElement).value);
  $('#component-list')
    .lastElementChild?.querySelector<HTMLInputElement | HTMLTextAreaElement>('textarea, input')
    ?.focus();
});
function jsonChanged() {
  jsonDirty = true;
  changed();
  try {
    importCardJson($('#component-json', HTMLTextAreaElement).value);
    $('#json-error').textContent = '';
  } catch (error) {
    $('#json-error').textContent = errorMessage(error);
  }
}
$('#component-json', HTMLTextAreaElement).addEventListener('input', jsonChanged);
function applyJson(value: string) {
  const imported = importCardJson(value);
  fill(
    {
      ...draft(),
      ...imported,
      additional_cards: imported.additional_cards || [],
      embed_card: imported.embed_card,
      seo: imported.seo,
      page_theme: imported.page_theme,
      page_colors: imported.page_colors,
      page_color_scheme: imported.page_color_scheme,
    },
    editing || (slugEdited ? fields.slug.value : slugify(imported.title || fields.title.value)),
  );
  changed();
}
$('#apply-json', HTMLButtonElement).addEventListener('click', () => {
  if (busy) return;
  try {
    applyJson($('#component-json', HTMLTextAreaElement).value);
    $('#json-panel', HTMLDialogElement).close();
  } catch (error) {
    $('#json-error').textContent = errorMessage(error);
  }
});
$('#copy-json', HTMLButtonElement).addEventListener('click', () =>
  copy($('#component-json', HTMLTextAreaElement).value),
);
function closeMenus() {
  document
    .querySelectorAll<HTMLElement>('.toolbar-menu:popover-open, #site-nav:popover-open')
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
    const rect = (
      mobile.matches ? $('#actions-toggle', HTMLButtonElement) : toggle
    ).getBoundingClientRect();
    menu.style.left = Math.max(12, Math.min(rect.right - 180, innerWidth - 192)) + 'px';
    menu.style.top = rect.bottom + 6 + 'px';
  });
}
$('#export-toggle', HTMLButtonElement).addEventListener('click', (event) => {
  if (!mobile.matches) return;
  event.preventDefault();
  closeMenus();
  $('#export-menu').showPopover();
  $('#copy-message-json', HTMLButtonElement).focus({ preventScroll: true });
});
$('#export-menu').addEventListener('toggle', (event) => {
  if (event.newState === 'closed' && mobile.matches)
    $('#actions-toggle', HTMLButtonElement).focus({ preventScroll: true });
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
function syncPickerOrigin(event: Event) {
  if (!(event.target instanceof Element)) return;
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
function exportJson(action: (json: string) => void) {
  if (busy) return;
  closeMenus();
  try {
    const card = jsonDirty
      ? importCardJson($('#component-json', HTMLTextAreaElement).value)
      : draft();
    action(
      card.additional_cards?.length ||
        card.seo ||
        card.page_theme ||
        card.page_colors ||
        card.page_color_scheme
        ? JSON.stringify(card, null, 2)
        : messageJson(card),
    );
    $('#json-error').textContent = '';
  } catch (error) {
    $('#form-status').textContent = errorMessage(error);
    validateEditor();
    toast(errorMessage(error));
  }
}
$('#copy-message-json', HTMLButtonElement).addEventListener('click', () => exportJson(copy));
$('#download-json', HTMLButtonElement).addEventListener('click', () =>
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
  $('#json-panel', HTMLDialogElement).showModal();
  $('#component-json', HTMLTextAreaElement).focus();
  try {
    if (!jsonEditor) {
      const { createJsonEditor } = await import('./code-editor.mts');
      if (!jsonEditor)
        jsonEditor = createJsonEditor($('#component-json', HTMLTextAreaElement), jsonChanged);
    }
    if ($('#json-panel', HTMLDialogElement).open) jsonEditor.focus();
  } catch {
    $('#json-error').textContent = 'code editor unavailable. you can still edit the text.';
  }
}
$('#edit-json', HTMLButtonElement).addEventListener('click', openJsonEditor);
$('#format-json', HTMLButtonElement).addEventListener('click', () => {
  try {
    if (jsonEditor) jsonEditor.format();
    else {
      $('#component-json', HTMLTextAreaElement).value = JSON.stringify(
        JSON.parse($('#component-json', HTMLTextAreaElement).value),
        null,
        2,
      );
      jsonChanged();
    }
  } catch (error) {
    $('#json-error').textContent = errorMessage(error);
  }
});
$('#show-url-import', HTMLButtonElement).addEventListener('click', () => {
  if (busy) return;
  $('#url-import-value', HTMLInputElement).value = fields.url.value;
  $('#url-import-error').textContent = '';
  $('#url-import-dialog', HTMLDialogElement).showModal();
});
$('#embed-mode', HTMLSelectElement).addEventListener('change', update);
$('#show-embed', HTMLButtonElement).addEventListener('click', () => {
  if (busy) return;
  closeMenus();
  $('#embed-dialog', HTMLDialogElement).showModal();
});
document.querySelectorAll<HTMLDialogElement>('.tool-dialog').forEach((dialog) => {
  dialog.setAttribute('closedby', 'any');
  dialog.addEventListener('cancel', (event) => {
    if (busy) event.preventDefault();
  });
  if (!Reflect.has(dialog, 'closedBy')) {
    const outside = (event: MouseEvent) => {
      const rect = dialog.getBoundingClientRect();
      return (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      );
    };
    let pressedOutside = false;
    // Older browsers need the manual backdrop handler.
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
$('#import-json-button', HTMLButtonElement).addEventListener('click', () => {
  if (!busy) $('#import-json', HTMLInputElement).click();
});
$('#import-json', HTMLInputElement).addEventListener('change', async () => {
  const input = $('#import-json', HTMLInputElement);
  const file = input.files?.[0];
  if (!file || busy) return;
  setBusy(true);
  try {
    if (file.size > MAX_PAGE_BYTES) throw new Error('json file is too large.');
    const value = await file.text();
    importCardJson(value);
    $('#component-json', HTMLTextAreaElement).value = value;
    jsonEditor?.set(value);
    jsonChanged();
  } catch (error) {
    $('#json-error').textContent = errorMessage(error);
  } finally {
    input.value = '';
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
document.querySelectorAll<HTMLButtonElement>('[data-template]').forEach((button) =>
  button.addEventListener('click', async () => {
    if (busy || (dirty && !(await confirmAction('replace current draft?', 'replace')))) return;
    const name = button.dataset.template;
    if (name !== 'launch' && name !== 'portfolio' && name !== 'event') return;
    const template = templates[name];
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

$('#url-import-form', HTMLFormElement).addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  $('#url-import-error').textContent = '';
  try {
    const url = httpsUrl($('#url-import-value', HTMLInputElement).value.trim());
    setBusy(true);
    $('#import-button', HTMLButtonElement).textContent = 'importing…';
    const card = readEditorCard(
      await api('/api/import', { method: 'POST', body: JSON.stringify({ url }) }),
    );
    fill(card, editing || (slugEdited ? fields.slug.value : slugify(card.title)));
    changed();
    $('#url-import-dialog', HTMLDialogElement).close();
  } catch (error) {
    $('#url-import-error').textContent = errorMessage(error);
  } finally {
    $('#import-button', HTMLButtonElement).textContent = 'use template';
    setBusy(false);
  }
});

const publishDialog = $('#publish-dialog', HTMLDialogElement),
  publishForm = $('#publish-form', HTMLFormElement),
  publishConfirm = $('#publish-confirm', HTMLInputElement),
  confirmPublish = $('#confirm-publish', HTMLButtonElement);
let termsAccepted = false;
$('#card-form', HTMLFormElement).addEventListener('submit', (event) => {
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
  const consent = publishConfirm.closest('label');
  if (consent) consent.hidden = termsAccepted;
  publishConfirm.required = !termsAccepted;
  publishConfirm.autofocus = !termsAccepted;
  confirmPublish.disabled = !termsAccepted;
  $('#publish-error').textContent = '';
  $('#publish-heading').textContent = editing ? 'save changes?' : 'publish card?';
  confirmPublish.textContent = editing ? 'save changes' : 'publish card';
  $('#publish-url', HTMLAnchorElement).textContent = cardUrl(fields.slug.value);
  $('#publish-url', HTMLAnchorElement).href = cardUrl(fields.slug.value);
  const renamed = editing && fields.slug.value !== editing;
  $('#publish-rename-warning').hidden = !renamed;
  $('#publish-update-notice').hidden = !editing;
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
  let savedSlug: string | undefined;
  try {
    const card = normalizeCard(draft(), cardUrl(fields.slug.value));
    setBusy(true);
    $('#publish-label').textContent = confirmPublish.textContent = 'saving…';
    $('#publish-error').textContent = '';
    const published = await withSessionLock(async () => {
      const session = readSession(await api('/api/session'));
      if (!session.authenticated && !session.guest) {
        if (editing) throw new Error('edit access expired. sign in with your token to recover it.');
        await api('/api/guest', { method: 'POST', body: '{}' });
      }
      return api(editing ? '/api/cards/' + editing : '/api/cards', {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify({ ...card, slug: fields.slug.value }),
      });
    });
    if (!isRecord(published) || typeof published.slug !== 'string')
      throw new Error('invalid save response.');
    editing = published.slug;
    usingTemplate = false;
    dirty = false;
    slugEdited = true;
    await refreshCards();
    savedSlug = published.slug;
  } catch (error) {
    $('#publish-error').textContent = errorMessage(error);
  } finally {
    setBusy(false);
    confirmPublish.textContent = editing ? 'save changes' : 'publish card';
  }
  if (savedSlug) {
    $('#publish-heading').textContent = 'your card is ready.';
    $('#publish-message').textContent = 'copy this link to share your card:';
    $('#publish-url', HTMLAnchorElement).textContent = $('#publish-url', HTMLAnchorElement).href =
      cardUrl(savedSlug);
    $('#publish-rename-warning').hidden = true;
    publishForm.hidden = true;
    $('#publish-result').hidden = false;
    $('#copy-published-link', HTMLButtonElement).focus();
  }
});

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('copied.');
    return true;
  } catch {
    toast('could not copy. select text to copy.');
    return false;
  }
}
$('#copy-published-link', HTMLButtonElement).addEventListener('click', async () => {
  const copied = await copy($('#publish-url', HTMLAnchorElement).href);
  $('#copy-published-label').textContent = copied ? 'copied!' : 'copy link';
  $('#publish-copy-error').textContent = copied
    ? ''
    : 'could not copy. select the link to copy it.';
});
$('#copy-code', HTMLButtonElement).addEventListener('click', () => {
  try {
    normalizeComponent(buildEmbed(draft()).component);
    copy($('#embed-code', HTMLTextAreaElement).value);
  } catch (error) {
    $('#form-status').textContent = errorMessage(error);
    validateEditor();
  }
});
$('#copy-route', HTMLButtonElement).addEventListener('click', () =>
  copy($('#embed-route', HTMLTextAreaElement).value),
);
$('#copy-prompt', HTMLButtonElement).addEventListener('click', async () => {
  if (!editing) return;
  const slug = editing;
  const button = $('#copy-prompt', HTMLButtonElement);
  button.disabled = true;
  try {
    const response = await fetch('/prompt.md');
    if (!response.ok) throw new Error('prompt unavailable.');
    const prompt = (await response.text()).replaceAll('https://linkbed.me/xxxx', cardUrl(slug));
    await copy(prompt);
  } catch {
    toast('could not load the prompt. try again.');
  } finally {
    update();
  }
});

async function accountRequest(
  path: '/api/login' | '/api/logout' | '/api/signup' | '/api/regenerate-token',
  data: Record<string, string> = {},
): Promise<{ token?: string } | undefined> {
  const errorNode = path === '/api/login' ? $('#sign-in-error') : $('#account-error');
  errorNode.textContent = '';
  refreshVersion++;
  setBusy(true);
  authBusy = true;
  try {
    return await withSessionLock(async () => {
      if (path === '/api/signup' && readSession(await api('/api/session')).authenticated)
        throw new Error('already signed in. reload to see your cards.');
      const result = await api(path, { method: 'POST', body: JSON.stringify(data) });
      if (!isRecord(result)) throw new Error('invalid account response.');
      const token = typeof result.token === 'string' ? result.token : undefined;
      if ((path === '/api/signup' || path === '/api/regenerate-token') && !token)
        throw new Error('access token missing from response.');
      return { token };
    });
  } catch (error) {
    errorNode.textContent = errorMessage(error);
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
    publishDialog.close();
    showView('cards');
    const result = await accountRequest('/api/signup');
    if (result?.token) {
      authenticated = true;
      showNewToken(result.token);
      await refreshCards();
    }
    finishAuth();
    if (result) $('#copy-token', HTMLButtonElement).focus({ preventScroll: true });
  }),
);
$('#regenerate-token', HTMLButtonElement).addEventListener('click', async () => {
  const message =
    'regenerate your access token? your current token stops working and other devices are signed out.';
  if (busy || !(await confirmAction(message, 'regenerate token'))) return;
  resumeEditor = false;
  const result = await accountRequest('/api/regenerate-token');
  if (result?.token) showNewToken(result.token);
  finishAuth();
  if (result) $('#copy-token', HTMLButtonElement).focus({ preventScroll: true });
});
function showNewToken(token: string) {
  newToken = token;
  $('#new-token').textContent = newToken;
  $('#download-token', HTMLButtonElement).removeAttribute('data-downloaded');
  $('#download-token', HTMLButtonElement).textContent = 'download';
}
const reportDialog = $('#report-dialog', HTMLDialogElement),
  reportForm = $('#report-form', HTMLFormElement),
  reportUrl = $('#report-url', HTMLInputElement),
  reportConfirm = $('#report-confirm', HTMLInputElement);
const reportReason = $('#report-reason', HTMLSelectElement),
  reportDetails = $('#report-details', HTMLInputElement);
for (const reason of REPORT_REASONS) reportReason.add(new Option(reason, reason));
function syncReportReason() {
  const other = reportReason.value === 'other';
  $('#report-details-field').hidden = !other;
  reportDetails.required = other;
  reportDetails.setCustomValidity('');
  reportReason.setCustomValidity('');
}
reportReason.addEventListener('change', () => {
  syncReportReason();
  if (reportDetails.required) reportDetails.focus();
});
reportDetails.addEventListener('input', () => reportDetails.setCustomValidity(''));
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
$('#report-abuse', HTMLButtonElement).addEventListener('click', () => {
  if (busy) return;
  closeMenus();
  reportForm.reset();
  reportUrl.value = editing ? cardUrl(editing) : '';
  syncReportReason();
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
  syncReportReason();
  for (const input of [reportUrl, reportConfirm, reportReason, reportDetails]) {
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
  let reason;
  try {
    reason = normalizeReportReason({ reason: reportReason.value, details: reportDetails.value });
  } catch (error) {
    const input = reportReason.value === 'other' ? reportDetails : reportReason;
    input.setCustomValidity(errorMessage(error));
    input.reportValidity();
    return;
  }
  setBusy(true);
  $('#send-report', HTMLButtonElement).textContent = 'sending…';
  $('#report-error').textContent = '';
  let sent = false;
  try {
    const link = normalizeReportLink(reportUrl.value, location.origin);
    await api('/api/reports', {
      method: 'POST',
      body: JSON.stringify({ url: link.url, confirmed: reportConfirm.checked, ...reason }),
    });
    sent = true;
  } catch (error) {
    $('#report-error').textContent = errorMessage(error);
  } finally {
    setBusy(false);
    $('#send-report', HTMLButtonElement).textContent = 'send report';
  }
  if (sent) {
    reportDialog.close();
    toast('report sent. thank you.');
  }
});

$('#show-sign-in', HTMLButtonElement).addEventListener('click', () => {
  if (busy) return;
  closeMenus();
  $('#sign-in-error').textContent = '';
  $('#sign-in-dialog', HTMLDialogElement).showModal();
  $('#sign-in-token', HTMLInputElement).focus();
});
$('#sign-in-form', HTMLFormElement).addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const result = await accountRequest('/api/login', {
    token: $('#sign-in-token', HTMLInputElement).value.trim(),
  });
  if (result) {
    $('#sign-in-token', HTMLInputElement).value = '';
    authenticated = true;
    $('#sign-in-dialog', HTMLDialogElement).close();
    await refreshCards();
  }
  finishAuth();
  if (result && resumeEditor) {
    resumeEditor = false;
    showView('editor');
  } else if (result) $('#cards-heading').focus({ preventScroll: true });
});
$('#sign-in-dialog', HTMLDialogElement).addEventListener('close', () => {
  $('#sign-in-token', HTMLInputElement).value = '';
});
$('#copy-token', HTMLButtonElement).addEventListener('click', () => copy(newToken));
$('#download-token', HTMLButtonElement).addEventListener('click', () => {
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
  $('#download-token', HTMLButtonElement).dataset.downloaded = 'true';
  $('#download-token', HTMLButtonElement).textContent = 'downloaded';
});
$('#finish-account', HTMLButtonElement).addEventListener('click', () => {
  if (!busy) $('#account-new-token', HTMLDialogElement).close();
});
$('#account-new-token', HTMLDialogElement).addEventListener('close', () => {
  newToken = '';
  $('#new-token').textContent = '';
  syncAccount();
  if (resumeEditor) {
    resumeEditor = false;
    showView('editor');
  } else $('#cards-heading').focus({ preventScroll: true });
});
$('#sign-out', HTMLButtonElement).addEventListener('click', async () => {
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

function applyTheme(theme: PageTheme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle', HTMLButtonElement).setAttribute(
    'aria-label',
    'switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode',
  );
  $('#theme-toggle', HTMLButtonElement).replaceChildren(
    icon(theme === 'dark' ? 'sun' : 'moon'),
    element('span', theme === 'dark' ? 'light mode' : 'dark mode', 'nav-theme-label'),
  );
  Coloris({ themeMode: theme });
  const picker = document.querySelector('emoji-picker');
  if (picker) picker.className = theme;
}
let theme: PageTheme | undefined;
try {
  theme = pageTheme(localStorage.getItem('theme'));
} catch {}
applyTheme(theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#theme-toggle', HTMLButtonElement).addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try {
    localStorage.setItem('theme', theme);
  } catch {}
});

function syncPagePreview(card: EditorCard, pageMode: boolean) {
  const theme = (pageMode && card.page_theme) || previewTheme || 'dark';
  const preview = $('.discord-window');
  preview.dataset.previewTheme = theme;
  const scheme = card.page_color_scheme || theme;
  const colors = pageMode
    ? { ...(card.page_color_scheme ? PAGE_COLORS[scheme] : {}), ...card.page_colors?.[scheme] }
    : {};
  const values = {
    '--preview-page-bg': colors.background,
    '--discord-card': colors.card,
    '--discord-text': colors.text,
    '--discord-ink': colors.text,
    '--discord-link': colors.links,
    '--discord-button': colors.button,
    '--discord-button-text': colors.button_text,
    '--discord-button-hover':
      colors.button &&
      'color-mix(in srgb, ' +
        colors.button +
        ' 85%, ' +
        (colors.button_text || colors.text || PAGE_COLORS[scheme].text) +
        ')',
    '--discord-border':
      pageMode &&
      'color-mix(in srgb, ' +
        (colors.text || PAGE_COLORS[scheme].text) +
        ' 25%, ' +
        (colors.card || PAGE_COLORS[scheme].card) +
        ')',
    '--discord-muted': colors.text && 'color-mix(in srgb, ' + colors.text + ' 75%, transparent)',
  };
  for (const [name, value] of Object.entries(values))
    if (value) preview.style.setProperty(name, value);
    else preview.style.removeProperty(name);
  document.querySelectorAll<HTMLButtonElement>('.preview-themes button').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.previewTheme === theme));
    button.disabled = !!(pageMode && card.page_theme);
  });
}
function applyPreviewTheme(theme: PageTheme) {
  previewTheme = theme;
  syncPagePreview(draft(), previewMode === 'page' && (!fields.url.value.trim() || pageTools));
}
let previewTheme: PageTheme | undefined;
try {
  previewTheme = pageTheme(localStorage.getItem('preview-theme'));
} catch {}
applyPreviewTheme(previewTheme ?? 'dark');
document.querySelectorAll<HTMLButtonElement>('.preview-themes button').forEach((button) => {
  button.addEventListener('click', () => {
    const theme = pageTheme(button.dataset.previewTheme);
    if (!theme) return;
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
if (typeof restored?.scroll === 'number' && Number.isFinite(restored.scroll))
  window.scrollTo(0, restored.scroll);
syncHeaderVisibility();
saveEditor();
syncAccount();
document.body.dataset.ready = '';
const initialCards: unknown = JSON.parse(
  document.querySelector('#initial-cards')?.textContent || 'null',
);
void refreshCards(initialCards);
