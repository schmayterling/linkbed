import { renderComponent } from './components.mjs';
import { PAGE_COLORS, REPORT_REASONS, normalizeReportReason } from './model.mjs';

const card = document.querySelector('#public-card');
const { component } = JSON.parse(document.getElementById('discord:component-embed').textContent);
const root = document.documentElement;
const preview = card.parentElement;
const appearance = JSON.parse(document.getElementById('page-appearance')?.textContent || '{}');
let theme = appearance.theme;
if (!['light', 'dark'].includes(theme)) {
  try {
    theme = localStorage.getItem('theme');
  } catch {}
}
if (!['light', 'dark'].includes(theme))
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
const components = JSON.parse(document.getElementById('page-cards')?.textContent || 'null') || [
  component,
];
renderComponent(card, components[0]);
components.slice(1).forEach((component, index) => {
  const article = document.createElement('article');
  article.className = 'discord-card';
  article.setAttribute('aria-label', `page card ${index + 2}`);
  card.parentElement.append(article);
  renderComponent(article, component);
});

const reportButton = document.querySelector('#report-abuse');
if (reportButton) {
  const dialog = document.querySelector('#report-dialog');
  const form = document.querySelector('#report-form');
  const reportUrl = document.querySelector('#report-url');
  const confirmation = document.querySelector('#report-confirm');
  const reason = document.querySelector('#report-reason');
  const details = document.querySelector('#report-details');
  for (const value of REPORT_REASONS) reason.add(new Option(value, value));
  function syncReason() {
    details.required = reason.value === 'other';
    document.querySelector('#report-details-field').hidden = !details.required;
    details.setCustomValidity('');
    reason.setCustomValidity('');
  }
  reason.addEventListener('change', () => {
    syncReason();
    if (details.required) details.focus();
  });
  details.addEventListener('input', () => details.setCustomValidity(''));
  const error = document.querySelector('#report-error');
  const success = document.querySelector('#report-success');
  const submit = document.querySelector('#send-report');
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
      input.setCustomValidity(failure.message);
      input.reportValidity();
      return;
    }
    sending = true;
    submit.textContent = 'sending…';
    const controls = [...dialog.querySelectorAll('button, input, select')];
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
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'report could not be sent. try again.');
      form.hidden = true;
      success.hidden = false;
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      sending = false;
      controls.forEach((control) => {
        control.disabled = false;
      });
      submit.textContent = 'send report';
    }
  });
}
