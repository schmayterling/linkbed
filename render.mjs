import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { embedScript, isSelfDestination } from './public/model.mjs';

export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );

export function renderEditor(card, url, starter) {
  const e = escapeHtml;
  const image = card?.images?.find((image) => !/\.(mp4|webm|mov)(?:$|[?#])/i.test(image));
  const description =
    card?.description || 'make custom discord cards with real buttons, images, and rich text.';
  const metadata = `<meta name="description" content="${e(description)}">
<meta property="og:title" content="${e(card?.title || 'linkbed')}">
<meta property="og:description" content="${e(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${e(url)}">
${image ? `<meta property="og:image" content="${e(image)}">` : ''}
${card?.color ? `<meta name="theme-color" content="${e(card.color)}">` : ''}
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

export function renderCard(card, url) {
  const e = escapeHtml;
  const redirect = card.url && !isSelfDestination(card.url, url);
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
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(card.title)} | linkbed</title>
<meta name="description" content="${e(card.description)}">
<meta property="og:title" content="${e(card.title)}">
<meta property="og:description" content="${e(card.description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="linkbed">
<meta property="og:url" content="${e(url)}">
${imageUrls.map((image) => `<meta property="og:image" content="${e(image)}">`).join('\n')}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(card.title)}">
<meta name="twitter:description" content="${e(card.description)}">
${card.color ? `<meta name="theme-color" content="${e(card.color)}">` : ''}
<link rel="icon" href="https://github.com/schmayterling.png?size=64" type="image/png">
<link rel="stylesheet" href="/style.css">
<script type="module" src="${redirect ? '/redirect.mjs' : '/card.mjs'}"></script>
${embedScript(card)}
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
<div class="discord-window public-card-preview"><article id="public-card" class="discord-card" aria-label="${e(card.title)}"></article></div>
<noscript><article class="published-card">
<h1>${e(card.title)}</h1><p class="published-description">${e(card.description)}</p>
${images ? `<div class="published-gallery">${images}</div>` : ''}
<div class="published-buttons">${buttons}</div>
</article></noscript>
<p class="public-note">paste this page’s link in discord to share its card.</p></main>`
}
</body></html>`;
}
