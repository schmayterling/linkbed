import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildEmbed,
  cardComponents,
  embedScript,
  isSelfDestination,
  pageBadges,
  seoMetadata,
} from './public/model.mjs';

export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );

function previewColor(card) {
  const color = buildEmbed(card).component.accent_color;
  return color == null ? null : '#' + color.toString(16).padStart(6, '0');
}

export function renderEditor(card, url, starter) {
  const e = escapeHtml;
  const { title, description, image } = card
    ? seoMetadata(card)
    : {
        title: 'linkbed',
        description: 'make custom discord cards with real buttons, images, and rich text.',
        image: '',
      };
  const color = card ? previewColor(card) : null;
  const metadata = `<meta name="description" content="${e(description)}">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${e(url)}">
${image ? `<meta property="og:image" content="${e(image)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${e(title)}">
<meta name="twitter:description" content="${e(description)}">
${image ? `<meta name="twitter:image" content="${e(image)}">` : ''}
<link rel="canonical" href="${e(url)}">
${color ? `<meta name="theme-color" content="${e(color)}">` : ''}
${card ? embedScript(card) : ''}
${starter ? `<script id="starter-card" type="application/json">${JSON.stringify(starter).replace(/</g, '\\u003c')}</script>` : ''}`;
  return readFileSync(fileURLToPath(new URL('./editor.html', import.meta.url)), 'utf8')
    .replace('<!-- card metadata -->', () => metadata)
    .replaceAll('<!-- public host -->', e(new URL(url).host));
}

export function renderNotFound(origin) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 | linkbed</title>
<meta name="description" content="this link does not exist or has been suspended">
<meta name="robots" content="noindex">
<meta property="og:title" content="404 | linkbed">
<meta property="og:description" content="this link does not exist or has been suspended">
<meta property="og:type" content="website">
<meta property="og:site_name" content="linkbed">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="404 | linkbed">
<meta name="twitter:description" content="this link does not exist or has been suspended">
<link rel="icon" href="https://github.com/schmayterling.png?size=64" type="image/png">
<link rel="stylesheet" href="/style.css">
</head><body class="public-page not-found-page">
<main class="public-content not-found-content">
<div class="not-found-art">
<img src="/not-found.gif" alt="" width="498" height="203">
<h1>404</h1>
</div>
<p>this link does not exist or has been suspended</p>
<a class="button secondary" href="${escapeHtml(origin)}">back to ${escapeHtml(new URL(origin).host)}</a>
</main>
</body></html>`;
}

export function renderCard(card, url, { sponsoredAt, verifiedAt, customBadges = [] } = {}) {
  const e = escapeHtml;
  const redirect = card.url && !isSelfDestination(card.url, url);
  const badge = (name, content) =>
    `<span class="page-badge">${content}<span>${e(name)}</span></span>`;
  const headerBadges = pageBadges({
    verifiedAt,
    sponsoredAt: card.sponsor_hidden ? null : sponsoredAt,
    customBadges,
  })
    .map(({ name, image, icon }) =>
      badge(
        name,
        image
          ? `<img src="${e(image)}" alt="" width="16" height="16" referrerpolicy="no-referrer">`
          : `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#${e(icon)}"></use></svg>`,
      ),
    )
    .join('');
  const appearance =
    !redirect && (card.page_theme || card.page_colors || card.page_color_scheme)
      ? {
          theme: card.page_theme || 'auto',
          colors: card.page_colors || {},
          ...(card.page_color_scheme ? { colorScheme: card.page_color_scheme } : {}),
        }
      : null;
  const { title, description, image } = seoMetadata(card);
  const color = previewColor(card);
  const imageUrls = card.images.filter((image) => !/\.(mp4|webm|mov)(?:$|[?#])/i.test(image));
  const images = imageUrls
    .map(
      (image, index) =>
        `<img src="${e(image)}" alt="${e(card.title)} | image ${index + 1}" referrerpolicy="no-referrer" loading="lazy">`,
    )
    .join('');
  const buttons = card.buttons
    .map(
      (button) =>
        `<a class="button" href="${e(button.url)}" target="_blank" rel="noopener noreferrer">${e(button.label)} <span aria-hidden="true">↗</span></a>`,
    )
    .join('');
  // ponytail: render blocking prevents startup shifts in supporting browsers; use SSR for universal coverage.
  return `<!doctype html>
<html lang="en"${!redirect && card.page_theme ? ` data-theme="${e(card.page_theme)}"` : ''}><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} | linkbed</title>
<meta name="description" content="${e(description)}">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="linkbed">
<meta property="og:url" content="${e(url)}">
${image ? `<meta property="og:image" content="${e(image)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${e(title)}">
<meta name="twitter:description" content="${e(description)}">
${image ? `<meta name="twitter:image" content="${e(image)}">` : ''}
<link rel="canonical" href="${e(url)}">
${color ? `<meta name="theme-color" content="${e(color)}">` : ''}
<link rel="icon" href="${e(card.seo?.favicon || 'https://github.com/schmayterling.png?size=64')}">
<link rel="stylesheet" href="/style.css">
<script type="module"${redirect ? '' : ' blocking="render"'} src="${redirect ? '/redirect.mjs' : '/card.mjs'}"></script>
${embedScript(card)}
${appearance ? `<script id="page-appearance" type="application/json">${JSON.stringify(appearance).replace(/</g, '\\u003c')}</script>` : ''}
${!redirect && card.additional_cards?.length ? `<script id="page-cards" type="application/json">${JSON.stringify(cardComponents(card)).replace(/</g, '\\u003c')}</script>` : ''}
</head><body class="public-page${redirect ? ' redirect-page' : ''}">
${
  redirect
    ? `<main class="public-content"><div class="redirect-status">
<span class="redirect-spinner" aria-hidden="true"></span>
<p role="status">redirecting to</p>
<a class="redirect-link" data-redirect href="${e(card.url)}" rel="noopener noreferrer">${e(card.url)}</a>
</div></main>`
    : `<header class="public-header"><a class="brand" href="/">linkbed</a><a class="text-link" href="/">make your own card ↗</a></header>
<main class="public-content">
${headerBadges ? `<div class="page-badges" aria-label="page badges">${headerBadges}</div>` : ''}
<div class="discord-window public-card-preview"><article id="public-card" class="discord-card" aria-label="${e(card.title)}"></article></div>
<noscript><article class="published-card">
<h1>${e(card.title)}</h1><p class="published-description">${e(card.description)}</p>
${images ? `<div class="published-gallery">${images}</div>` : ''}
<div class="published-buttons">${buttons}</div>
</article></noscript>
<footer class="site-footer public-footer">
<a href="/">made with linkbed</a>
<button class="text-button" id="report-abuse" type="button">report abuse</button>
</footer></main>
<dialog id="report-dialog" class="tool-dialog account-dialog" aria-labelledby="report-heading" closedby="any">
<div class="card-titlebar"><h2 id="report-heading">report abuse</h2><button class="text-button" type="button" data-close aria-label="close abuse report"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#x"></use></svg></button></div>
<form id="report-form">
<label for="report-url">link to report</label>
<input id="report-url" type="url" value="${e(url)}" readonly>
<label for="report-reason">reason</label><select id="report-reason" required><option value="">choose a reason</option></select>
<div id="report-details-field" hidden><label for="report-details">tell me why</label><input id="report-details" maxlength="2000"></div>
<label class="confirm-field"><input id="report-confirm" type="checkbox" required><span>i confirm that this link contains abusive content. misuse of this form may bar me from creating linkbeds or reporting other instances.</span></label>
<p id="report-error" class="form-status" role="status"></p>
<div class="dialog-actions"><button type="button" class="button secondary small" data-close>cancel</button><button class="button primary small" id="send-report" type="submit">send report</button></div>
</form>
<p id="report-success" role="status" hidden>report sent. thank you.</p>
</dialog>`
}
</body></html>`;
}
