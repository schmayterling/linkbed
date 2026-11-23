import { autoFormatField, fieldValidator, renderComponent } from './components.mts';
import { $, element } from './editor-dom.mts';
import { PAGE_COLORS, formatColor, normalizeColor } from './model.mts';
import type {
  ContainerComponent,
  Page,
  PageAppearance,
  PageCard,
  PageColors,
  PageColorKey,
  PageTheme,
} from './model.mts';

export type PreviewMode = 'discord' | 'page';
type PreviewPage = PageAppearance & Pick<Page, 'url'>;

let previewTheme: PageTheme = 'dark';

export function pageTheme(value: unknown): PageTheme | undefined {
  return value === 'light' || value === 'dark' ? value : undefined;
}

const themes = ['light', 'dark'] as const;
const colorKeys = ['background', 'text', 'card', 'links', 'button', 'button_text'] as const;
const pageColorFields: Record<PageTheme, Map<PageColorKey, HTMLInputElement>> = {
  light: new Map(),
  dark: new Map(),
};
const colorLabels: Partial<Record<PageColorKey, string>> = {
  button: 'button background',
  button_text: 'button text',
};

export function mountPagePalettes(): void {
  for (const mode of themes) {
    for (const name of colorKeys) {
      const value = PAGE_COLORS[mode][name];
      const label = element('label', colorLabels[name] ?? name);
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
}

export function createPagePaletteChecks(): ReturnType<typeof fieldValidator>[] {
  return themes.flatMap((mode) =>
    Array.from(pageColorFields[mode], ([name, input]) =>
      fieldValidator(input, normalizeColor, mode + ' ' + name),
    ),
  );
}

export function readPageAppearance(): PageAppearance {
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
  return {
    ...(theme ? { page_theme: theme } : {}),
    ...(colorScheme ? { page_color_scheme: colorScheme } : {}),
    ...(Object.keys(pageColors).length ? { page_colors: pageColors } : {}),
  };
}

export function fillPageAppearance(card: PageAppearance): void {
  $('#page-theme', HTMLSelectElement).value = card.page_theme || 'auto';
  $('#page-color-scheme', HTMLSelectElement).value = card.page_color_scheme || 'auto';
  for (const mode of themes)
    for (const [name, input] of pageColorFields[mode])
      input.value = card.page_colors?.[mode]?.[name] || PAGE_COLORS[mode][name];
}

export function bindPageAppearance(changed: () => void, isBusy: () => boolean): void {
  $('.page-appearance').addEventListener('input', changed);
  $('#page-theme', HTMLSelectElement).addEventListener('change', changed);
  $('#page-color-scheme', HTMLSelectElement).addEventListener('change', changed);
  $('#reset-page-appearance', HTMLButtonElement).addEventListener('click', () => {
    if (isBusy()) return;
    fillPageAppearance({});
    changed();
  });
}

export function syncPageAppearance(card: PageAppearance, pageTools: boolean, busy: boolean): void {
  $('.page-appearance').hidden = !pageTools;
  $('#reset-page-appearance', HTMLButtonElement).disabled =
    busy || !(card.page_theme || card.page_colors || card.page_color_scheme);
  for (const mode of themes) {
    const fieldset = $('[data-palette="' + mode + '"]').closest('fieldset');
    if (fieldset) fieldset.hidden = !!card.page_color_scheme && card.page_color_scheme !== mode;
  }
}

export function syncPageSwatches(): void {
  for (const mode of themes) {
    for (const [name, input] of pageColorFields[mode]) {
      if (input.parentElement)
        input.parentElement.style.color = /^#[0-9a-f]{6}$/i.test(input.value)
          ? input.value
          : PAGE_COLORS[mode][name];
    }
  }
}

export function bindPreviewModes(changeMode: (mode: PreviewMode) => void): void {
  document.querySelectorAll<HTMLButtonElement>('[data-preview-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.previewMode;
      if (mode !== 'discord' && mode !== 'page') return;
      changeMode(mode);
    });
  });
}

export function renderDiscordPreview(previewRoot: ContainerComponent | undefined): void {
  if (previewRoot) renderComponent($('#preview-card'), previewRoot);
  else $('#preview-card').replaceChildren();
}

function isPagePreview(card: PreviewPage, mode: PreviewMode, pageTools: boolean): boolean {
  return mode === 'page' && (!card.url || pageTools);
}

export function renderPagePreview(
  card: PreviewPage,
  roots: readonly PageCard[],
  mode: PreviewMode,
  pageTools: boolean,
): boolean {
  const pagePreview = isPagePreview(card, mode, pageTools);
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
  syncPreviewTheme(card, pagePreview);
  return pagePreview;
}

function syncPreviewTheme(card: PageAppearance, pageMode: boolean): void {
  const theme = (pageMode && card.page_theme) || previewTheme;
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

export function initPreviewTheme(
  readPreview: () => { card: PreviewPage; mode: PreviewMode; pageTools: boolean },
): void {
  function updateTheme() {
    const { card, mode, pageTools } = readPreview();
    syncPreviewTheme(card, isPagePreview(card, mode, pageTools));
  }
  try {
    previewTheme = pageTheme(localStorage.getItem('preview-theme')) ?? 'dark';
  } catch {}
  updateTheme();
  document.querySelectorAll<HTMLButtonElement>('.preview-themes button').forEach((button) => {
    button.addEventListener('click', () => {
      const theme = pageTheme(button.dataset.previewTheme);
      if (!theme) return;
      previewTheme = theme;
      updateTheme();
      try {
        localStorage.setItem('preview-theme', theme);
      } catch {}
    });
  });
}
