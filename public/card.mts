import { renderComponent } from './components.mts';
import { PAGE_COLORS, REPORT_REASONS, normalizeReportReason } from './model.mts';
import type { PageCard, PageColors, PageTheme } from './model.mts';

type PublishedAppearance = {
  theme?: PageTheme | 'auto';
  colorScheme?: PageTheme;
  colors?: PageColors;
};

function required<T extends HTMLElement>(id: string, elementType: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof elementType)) throw new Error('missing #' + id);
  return node;
}

function isPageTheme(value: string | null | undefined): value is PageTheme {
  return value === 'light' || value === 'dark';
}

// renderCard emits this ID on an article inside the preview.
const card = document.querySelector<HTMLElement>('#public-card');
const preview = card?.parentElement;
if (!card || !preview) throw new Error('missing public card preview.');
const embedText = document.getElementById('discord:component-embed')?.textContent;
if (!embedText) throw new Error('missing public card embed.');
const embed: unknown = JSON.parse(embedText);
if (!embed || typeof embed !== 'object' || !('component' in embed))
  throw new Error('invalid public card embed.');

const root = document.documentElement;
const appearanceData: unknown = JSON.parse(
  document.getElementById('page-appearance')?.textContent || '{}',
);
if (!appearanceData || typeof appearanceData !== 'object' || Array.isArray(appearanceData))
  throw new Error('invalid page appearance.');
// renderCard emits settings from normalizeCard or the empty default above.
const appearance = appearanceData as PublishedAppearance;
let theme = appearance.theme;
if (!isPageTheme(theme)) {
  try {
    const savedTheme = localStorage.getItem('theme');
    if (isPageTheme(savedTheme)) theme = savedTheme;
  } catch {
    // Use the system preference when storage is unavailable.
  }
}
if (!isPageTheme(theme))
  theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
root.dataset.theme = theme;
preview.dataset.previewTheme = theme;
const scheme = appearance.colorScheme || theme;
const colors = {
  ...(appearance.colorScheme ? PAGE_COLORS[scheme] : {}),
  ...appearance.colors?.[scheme],
};
const values = {
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
    'color-mix(in srgb, ' +
    (colors.text || PAGE_COLORS[scheme].text) +
    ' 25%, ' +
    (colors.card || PAGE_COLORS[scheme].card) +
    ')',
  '--discord-muted': colors.text && 'color-mix(in srgb, ' + colors.text + ' 75%, transparent)',
};
for (const [name, value] of Object.entries(values))
  if (value) preview.style.setProperty(name, value);
for (const [name, value] of Object.entries({
  '--page-bg': colors.background,
  '--ink': colors.text,
  '--accent': colors.links,
  '--line': values['--discord-border'],
  '--muted': values['--discord-muted'],
}))
  if (value) root.style.setProperty(name, value);
const pageCards: unknown = JSON.parse(document.getElementById('page-cards')?.textContent || 'null');
const componentData = pageCards || [embed.component];
if (!Array.isArray(componentData) || !componentData.length)
  throw new Error('invalid public page cards.');
// renderCard serializes cardComponents for multiple cards and embedScript for the single-card fallback.
const components = componentData as PageCard[];
renderComponent(card, components[0]);
components.slice(1).forEach((component, index) => {
  const article = document.createElement('article');
  article.className = 'discord-card';
  article.setAttribute('aria-label', `page card ${index + 2}`);
  preview.append(article);
  renderComponent(article, component);
});

const reportButton = document.querySelector('#report-abuse');
if (reportButton) {
  const dialog = required('report-dialog', HTMLDialogElement);
  dialog.style.colorScheme = scheme;
  for (const [name, value] of Object.entries({
    '--bg': colors.card,
    '--surface': colors.card,
    '--editor-surface': colors.card,
    '--accent': colors.button,
    '--accent-ink': colors.button_text,
  }))
    if (value) dialog.style.setProperty(name, value);
  const form = required('report-form', HTMLFormElement);
  const reportUrl = required('report-url', HTMLInputElement);
  const confirmation = required('report-confirm', HTMLInputElement);
  const reason = required('report-reason', HTMLSelectElement);
  const details = required('report-details', HTMLInputElement);
  const detailsField = required('report-details-field', HTMLDivElement);
  for (const value of REPORT_REASONS) reason.add(new Option(value, value));
  function syncReason() {
    details.required = reason.value === 'other';
    detailsField.hidden = !details.required;
    details.setCustomValidity('');
    reason.setCustomValidity('');
  }
  reason.addEventListener('change', () => {
    syncReason();
    if (details.required) details.focus();
  });
  details.addEventListener('input', () => details.setCustomValidity(''));
  const error = required('report-error', HTMLParagraphElement);
  const success = required('report-success', HTMLParagraphElement);
  const submit = required('send-report', HTMLButtonElement);
  let sending = false;
  reportButton.addEventListener('click', () => {
    form.reset();
    syncReason();
    form.hidden = false;
    success.hidden = true;
    error.textContent = '';
    dialog.showModal();
    confirmation.focus();
  });
  dialog.addEventListener('cancel', (event) => {
    if (sending) event.preventDefault();
  });
  for (const button of dialog.querySelectorAll('[data-close]'))
    button.addEventListener('click', () => {
      if (!sending) dialog.close();
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
    dialog.addEventListener('pointerdown', (event) => {
      pressedOutside = event.target === dialog && outside(event);
    });
    dialog.addEventListener('click', (event) => {
      if (pressedOutside && event.target === dialog && outside(event) && !sending) dialog.close();
      pressedOutside = false;
    });
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending || !form.reportValidity()) return;
    let reportReason;
    try {
      reportReason = normalizeReportReason({ reason: reason.value, details: details.value });
    } catch (failure) {
      const input = reason.value === 'other' ? details : reason;
      input.setCustomValidity(failure instanceof Error ? failure.message : String(failure));
      input.reportValidity();
      return;
    }
    sending = true;
    submit.textContent = 'sending…';
    const controls = [...dialog.querySelectorAll('button, input, select')].filter(
      (control) =>
        control instanceof HTMLButtonElement ||
        control instanceof HTMLInputElement ||
        control instanceof HTMLSelectElement,
    );
    controls.forEach((control) => {
      control.disabled = true;
    });
    error.textContent = '';
    try {
      const response = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: reportUrl.value,
          confirmed: confirmation.checked,
          ...reportReason,
        }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message =
          result &&
          typeof result === 'object' &&
          'error' in result &&
          typeof result.error === 'string'
            ? result.error
            : '';
        throw new Error(message || 'report could not be sent. try again.');
      }
      form.hidden = true;
      success.hidden = false;
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure);
    } finally {
      sending = false;
      controls.forEach((control) => {
        control.disabled = false;
      });
      submit.textContent = 'send report';
    }
  });
}
