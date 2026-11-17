export const MAX_BYTES = 3000;
export const MAX_CARDS = 7;
export const MAX_BADGES = 40;
export const MAX_CUSTOM_BADGES = 20;
export const REPORT_REASONS = [
  'spam or scams',
  'harassment or hate',
  'violence or threats',
  'sexual content',
  'personal information',
  'other',
];

export const PAGE_COLORS = {
  light: {
    background: '#fffaea',
    card: '#f2f3f5',
    text: '#202225',
    links: '#006cb8',
    button: '#e4e6e8',
    button_text: '#202225',
  },
  dark: {
    background: '#141414',
    card: '#393a41',
    text: '#f2f3f5',
    links: '#64baff',
    button: '#44444b',
    button_text: '#f2f3f5',
  },
};

export class ValidationError extends Error {
  status = 400;
}

function publicUrl(value, label, max, allowHttp) {
  if (typeof value !== 'string' || value.length > max)
    throw new ValidationError(`${label} is too long.`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError(`enter a valid ${label}.`);
  }
  if (url.href.length > max) throw new ValidationError(`${label} is too long after url encoding.`);
  if (
    !(url.protocol === 'https:' || (allowHttp && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new ValidationError(
      `${label} must use ${allowHttp ? 'http or https' : 'https'}, without a password or custom port.`,
    );
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || /(?:^|\.)(localhost|local|internal|lan|invalid|test)$/.test(host)) {
    throw new ValidationError(`${label} must be a public website.`);
  }
  return url.href;
}

export function httpsUrl(value, label = 'url', max = 2048) {
  return publicUrl(value, label, max, false);
}

export function isSelfDestination(value, pageUrl) {
  if (value == null) return false;
  const destination = new URL(value);
  const page = new URL(pageUrl);
  const hosts = [page.hostname, 'linkbed.me', 'www.linkbed.me', 'linkbed.ryana.dev'];
  if (!hosts.includes(destination.hostname.replace(/\.$/, ''))) return false;
  const slug = page.pathname.split('/').filter(Boolean).at(-1);
  let path = destination.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {}
  path = path.replace(/\/$/, '');
  return (
    path === '/' + slug ||
    path === '/p/' + slug ||
    (path === '/api/index' && destination.searchParams.get('card') === slug)
  );
}

export function destinationUrl(value, pageUrl) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  const url = httpsUrl(value, 'destination url');
  if (pageUrl && isSelfDestination(url, pageUrl))
    throw new ValidationError('destination url cannot be this card’s own link.');
  return url;
}

export function publicHttpUrl(value, label = 'url', max = 2048) {
  return publicUrl(value, label, max, true);
}

export function text(value, label, max, required = false) {
  if (typeof value !== 'string' || (required && !value.trim())) {
    throw new ValidationError(`${label} ${required ? 'is required' : 'must be text'}.`);
  }
  if (value.length > max)
    throw new ValidationError(`${label} must be under ${max + 1} characters.`);
  return value.trim();
}

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError(`invalid ${label}.`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new ValidationError(`unknown ${label} field: ${key}.`);
  }
}

function boolean(source, target, key) {
  if (!(key in source)) return;
  if (typeof source[key] !== 'boolean') throw new ValidationError(`${key} must be a boolean.`);
  target[key] = source[key];
}

function string(value, label, max, required = false) {
  text(value, label, max, required);
  return value;
}

function mediaItem(value, label) {
  object(value, ['media', 'description', 'spoiler'], label);
  object(value.media, ['url'], 'media');
  const item = { media: { url: publicHttpUrl(value.media.url, 'media url') } };
  if ('description' in value)
    item.description =
      value.description === null ? null : string(value.description, 'media description', 1024);
  boolean(value, item, 'spoiler');
  return item;
}

function normalizeEmojiPresentation(value) {
  return !value?.id && typeof value?.name === 'string'
    ? { ...value, name: value.name.replace(/(\p{Emoji_Presentation})\uFE0F/gu, '$1') }
    : value;
}

export function normalizeEmoji(value) {
  object(value, ['name', 'id', 'animated'], 'emoji');
  const result = {};
  if ('id' in value) {
    if (
      value.id !== null &&
      (typeof value.id !== 'string' ||
        !/^[1-9]\d{0,19}$/.test(value.id) ||
        BigInt(value.id) > 18446744073709551615n)
    ) {
      throw new ValidationError('emoji id must be a snowflake string or null.');
    }
    result.id = value.id;
  }
  if ('name' in value)
    result.name = value.name === null ? null : string(value.name, 'emoji name', Infinity, true);
  boolean(value, result, 'animated');
  if (!result.id && !result.name) throw new ValidationError('emoji needs a name or id.');
  return normalizeEmojiPresentation(result);
}

export function formatUrl(value) {
  value = value.trim();
  const candidate = value.startsWith('//')
    ? 'https:' + value
    : /^[^\s/:?#]+\.[^\s/:?#]+(?::\d+)?(?:[/?#]|$)/.test(value)
      ? 'https://' + value
      : value;
  try {
    const url = new URL(candidate);
    if (['http:', 'https:'].includes(url.protocol)) return url.href;
  } catch {}
  return value;
}

export function formatColor(value) {
  const hex = value.trim().replace(/^#/, '');
  if (/^[\da-f]{3}$/i.test(hex))
    return (
      '#' +
      [...hex]
        .map((char) => char + char)
        .join('')
        .toLowerCase()
    );
  return /^[\da-f]{6}$/i.test(hex) ? '#' + hex.toLowerCase() : value.trim();
}

export function formatSlug(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');
}

export function normalizeColor(value) {
  if (value !== null && (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)))
    throw new ValidationError('choose a six-digit hex color.');
  return value?.toLowerCase() ?? null;
}

export function normalizeSlug(value) {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ||
    value.length > 60 ||
    ['api', 'healthz', 'admin', 'terms', 'privacy', '404'].includes(value)
  ) {
    throw new ValidationError(
      'use 1–60 lowercase letters, numbers, and single hyphens for the link.',
    );
  }
  return value;
}

export function normalizeReportReason({ reason, details } = {}) {
  if (!REPORT_REASONS.includes(reason))
    throw new ValidationError('choose a reason for this report.');
  return {
    reason,
    details:
      reason === 'other'
        ? text(typeof details === 'string' ? details.trim() : details, 'report details', 2000, true)
        : null,
  };
}

export function normalizeReportLink(value, origin) {
  if (typeof value !== 'string' || value.length > 2048)
    throw new ValidationError('enter a valid linkbed link.');
  let url;
  try {
    url = new URL(formatUrl(value));
  } catch {
    throw new ValidationError('enter a valid linkbed link.');
  }
  const origins = [
    new URL(origin).origin,
    'https://linkbed.me',
    'https://www.linkbed.me',
    'https://linkbed.ryana.dev',
  ];
  if (url.username || url.password || !origins.includes(url.origin))
    throw new ValidationError('enter a link from this site.');
  const match = url.pathname.match(/^\/(?:p\/)?([a-z0-9-]+)\/?$/);
  if (!match) throw new ValidationError('enter a link to a card.');
  const slug = normalizeSlug(match[1]);
  return { slug, url: url.origin + '/' + slug };
}

export function thumbnailUrl(value) {
  const url = publicHttpUrl(value, 'media url');
  let path = new URL(url).pathname;
  try {
    path = decodeURIComponent(path);
  } catch {}
  if (/\.(mp4|webm|mov|m4v|avi|mkv|mpeg|mpg|ogv)$/i.test(path))
    throw new ValidationError('thumbnail must be an image.');
  return url;
}

const fields = {
  1: ['components'],
  2: ['style', 'url', 'label', 'emoji', 'disabled'],
  9: ['components', 'accessory'],
  10: ['content'],
  11: ['media', 'description', 'spoiler'],
  12: ['items'],
  14: ['divider', 'spacing'],
  17: ['components', 'accent_color', 'spoiler'],
};

export function pageBadges({ verifiedAt, sponsoredAt, customBadges = [] } = {}) {
  return [
    ...(verifiedAt != null ? [{ name: 'verified', icon: 'badge-check' }] : []),
    ...(sponsoredAt != null ? [{ name: 'sponsor', icon: 'heart' }] : []),
    ...customBadges,
  ];
}

export function normalizeCustomBadges(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_BADGES)
    throw new ValidationError(`use up to ${MAX_CUSTOM_BADGES} custom badges.`);
  return value.map((badge) => {
    object(badge, ['name', 'image'], 'custom badge');
    return {
      name: text(badge.name, 'badge name', 80, true),
      image: httpsUrl(badge.image, 'badge image url'),
    };
  });
}

export function isBadgeCase(root) {
  return root?.type === 'badge_case';
}

function cardAppearance(source, target) {
  if ('accent_color' in source) {
    if (
      source.accent_color !== null &&
      (!Number.isInteger(source.accent_color) ||
        source.accent_color < 0 ||
        source.accent_color > 16777215)
    ) {
      throw new ValidationError('accent_color must be null or a 24-bit color.');
    }
    target.accent_color = source.accent_color;
  }
  boolean(source, target, 'spoiler');
}

export function normalizePageCard(root) {
  if (!isBadgeCase(root)) return normalizeComponent(root);
  object(root, ['type', 'title', 'description', 'accent_color', 'spoiler', 'badges'], 'badge case');
  if (!Array.isArray(root.badges) || !root.badges.length || root.badges.length > MAX_BADGES)
    throw new ValidationError(`use one to ${MAX_BADGES} badges per badge case.`);
  const result = {
    type: 'badge_case',
    title:
      'title' in root ? text(root.title, 'badge case title', 256) || 'badge case' : 'badge case',
    badges: root.badges.map((badge) => {
      object(badge, ['image', 'url', 'label'], 'badge');
      const result = { image: publicHttpUrl(badge.image, 'badge image url') };
      if ('url' in badge) result.url = publicHttpUrl(badge.url, 'badge link url');
      if ('label' in badge) result.label = text(badge.label, 'badge label', 80);
      return result;
    }),
  };
  if ('description' in root)
    result.description = string(root.description, 'badge case description', 4096);
  cardAppearance(root, result);
  return result;
}

export function normalizeComponent(component) {
  const ids = new Set();
  let count = 0;
  let galleries = 0;
  function node(value, allowed) {
    object(
      value,
      ['type', 'id', ...(Object.hasOwn(fields, value?.type) ? fields[value.type] : [])],
      'component',
    );
    if (!allowed.includes(value.type))
      throw new ValidationError('component type is not allowed here.');
    if (++count > 40) throw new ValidationError('use up to 40 components.');
    const result = { type: value.type };
    if ('id' in value) {
      if (!Number.isInteger(value.id) || value.id < 0 || value.id > 4294967295)
        throw new ValidationError('component id must be an unsigned 32-bit integer.');
      if (value.id !== 0 && ids.has(value.id))
        throw new ValidationError('component ids must be unique.');
      if (value.id !== 0) ids.add(value.id);
      result.id = value.id;
    }
    function children(types, min, max) {
      if (
        !Array.isArray(value.components) ||
        value.components.length < min ||
        value.components.length > max
      ) {
        throw new ValidationError(`use ${min} to ${max} child components.`);
      }
      result.components = value.components.map((child) => node(child, types));
    }
    switch (value.type) {
      case 17:
        cardAppearance(value, result);
        children([1, 9, 10, 12, 14], 1, 39);
        break;
      case 1:
        children([2], 1, 5);
        break;
      case 9:
        children([10], 1, 3);
        result.accessory = node(value.accessory, [2, 11]);
        break;
      case 2:
        if (value.style !== 5) throw new ValidationError('buttons must use link style 5.');
        result.style = 5;
        result.url = publicHttpUrl(value.url, 'button url', 512);
        if ('label' in value) result.label = string(value.label, 'button label', 80, true);
        if ('emoji' in value) result.emoji = normalizeEmoji(value.emoji);
        if (!result.label && !result.emoji)
          throw new ValidationError('button needs a label or emoji.');
        boolean(value, result, 'disabled');
        break;
      case 10:
        result.content = string(value.content, 'text content', Infinity, true);
        break;
      case 11: {
        const item = mediaItem(
          Object.fromEntries(
            Object.entries(value).filter(([key]) => key !== 'type' && key !== 'id'),
          ),
          'thumbnail',
        );
        thumbnailUrl(item.media.url);
        Object.assign(result, item);
        break;
      }
      case 12:
        if (!Array.isArray(value.items) || !value.items.length || value.items.length > 10)
          throw new ValidationError('use one to ten gallery items.');
        galleries += value.items.length;
        if (galleries > 10)
          throw new ValidationError('use up to ten gallery items across the embed.');
        result.items = value.items.map((item) => mediaItem(item, 'gallery item'));
        break;
      case 14:
        boolean(value, result, 'divider');
        if ('spacing' in value) {
          if (value.spacing !== 1 && value.spacing !== 2)
            throw new ValidationError('separator spacing must be 1 or 2.');
          result.spacing = value.spacing;
        }
        break;
    }
    return result;
  }
  const result = node(component, [17]);
  checkBytes({ component: result });
  return result;
}

function visit(component, callback) {
  if (!component || typeof component !== 'object') return;
  callback(component);
  if (Array.isArray(component.components))
    component.components.forEach((child) => visit(child, callback));
  if (component.accessory) visit(component.accessory, callback);
}

export function componentStats(component) {
  let components = 0;
  let media = 0;
  visit(component, (node) => {
    components++;
    if (node.type === 12 && Array.isArray(node.items)) media += node.items.length;
  });
  return { components, media };
}

export function componentImages(component) {
  const images = [];
  visit(component, (node) => {
    if (node.type === 11 && typeof node.media?.url === 'string') images.push(node.media.url);
    if (node.type === 12 && Array.isArray(node.items)) {
      for (const item of node.items)
        if (typeof item?.media?.url === 'string') images.push(item.media.url);
    }
  });
  return images;
}

export function componentUrls(component) {
  const urls = [];
  visit(component, (node) => {
    if (isBadgeCase(node) && Array.isArray(node.badges)) {
      for (const badge of node.badges) {
        if (typeof badge?.image === 'string') urls.push(badge.image);
        if (typeof badge?.url === 'string') urls.push(badge.url);
      }
    }
    if (node.type === 2 && typeof node.url === 'string') urls.push(node.url);
    if (node.type === 11 && typeof node.media?.url === 'string') urls.push(node.media.url);
    if (node.type === 12 && Array.isArray(node.items)) {
      for (const item of node.items)
        if (typeof item?.media?.url === 'string') urls.push(item.media.url);
    }
  });
  return urls;
}

export function normalizeSeo(value) {
  if (value == null) return undefined;
  object(value, ['title', 'image', 'favicon'], 'seo');
  const title = text(value.title ?? '', 'seo title', 256);
  const image = text(value.image ?? '', 'seo image url', 2048);
  const favicon = text(value.favicon ?? '', 'seo favicon url', 2048);
  const seo = {};
  if (title) seo.title = title;
  if (image) seo.image = httpsUrl(image, 'seo image url');
  if (favicon) seo.favicon = httpsUrl(favicon, 'seo favicon url');
  return Object.keys(seo).length ? seo : undefined;
}

export function normalizeEmbedCard(value, count) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0 || value >= count)
    throw new ValidationError('choose a card from this page for the embed.');
  return value;
}

function normalizeAppearance(value) {
  const result = {};
  if (value.page_theme != null && value.page_theme !== 'auto') {
    if (!['light', 'dark'].includes(value.page_theme))
      throw new ValidationError('choose automatic, light, or dark for the page theme.');
    result.page_theme = value.page_theme;
  }
  if (value.page_color_scheme != null && value.page_color_scheme !== 'auto') {
    if (!['light', 'dark'].includes(value.page_color_scheme))
      throw new ValidationError('choose separate, light, or dark for the page color scheme.');
    result.page_color_scheme = value.page_color_scheme;
  }
  if (value.page_colors == null) return result;
  object(value.page_colors, ['light', 'dark'], 'page colors');
  const colors = {};
  for (const theme of ['light', 'dark']) {
    if (value.page_colors[theme] == null) continue;
    object(value.page_colors[theme], Object.keys(PAGE_COLORS[theme]), 'page colors');
    const palette = {};
    for (const [key, color] of Object.entries(value.page_colors[theme])) {
      if (color == null || color === '') continue;
      palette[key] = normalizeColor(color);
    }
    if (Object.keys(palette).length) colors[theme] = palette;
  }
  if (Object.keys(colors).length) result.page_colors = colors;
  return result;
}

export function normalizeCard(value, pageUrl) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ValidationError('invalid card.');
  const title = text(value.title, 'title', 256, true);
  const description = text(value.description ?? '', 'description', 4096);
  const url = destinationUrl(value.url, pageUrl);
  const additional = value.additional_cards === undefined ? [] : value.additional_cards;
  if (!Array.isArray(additional) || additional.length >= MAX_CARDS)
    throw new ValidationError(`use up to ${MAX_CARDS} cards per page.`);
  const component = 'component' in value ? normalizePageCard(value.component) : null;
  const additionalCards = additional.map(normalizePageCard);
  const roots = [component, ...additionalCards];
  if (component && !roots.some((root) => root?.type === 17))
    throw new ValidationError('keep at least one discord card on this page.');
  const embedCard = normalizeEmbedCard(value.embed_card, roots.length);
  if (embedCard !== null && isBadgeCase(roots[embedCard]))
    throw new ValidationError('choose a discord card for the embed.');
  const seo = normalizeSeo(value.seo);
  const extras = {
    ...(additionalCards.length ? { additional_cards: additionalCards } : {}),
    ...(embedCard !== null ? { embed_card: embedCard } : {}),
    ...(seo ? { seo } : {}),
    ...normalizeAppearance(value),
  };
  boolean(value, extras, 'sponsor_hidden');
  const color = normalizeColor(value.color === undefined ? '#5865f2' : value.color);
  if (component) {
    return {
      title,
      description,
      url,
      color: color?.toLowerCase() ?? null,
      buttons: [],
      images: componentImages(component),
      component,
      ...extras,
    };
  }
  const legacyButtons = value.buttons === undefined ? [] : value.buttons;
  const legacyImages = value.images === undefined ? [] : value.images;
  if (!Array.isArray(legacyButtons) || legacyButtons.length > 5)
    throw new ValidationError('use up to five buttons.');
  if (!Array.isArray(legacyImages) || legacyImages.length > 10)
    throw new ValidationError('use up to ten images.');
  const buttons = legacyButtons.map((button) => ({
    label: text(button?.label, 'button label', 80, true),
    url: httpsUrl(button?.url, 'button url', 512),
  }));
  const images = legacyImages.map((image) => httpsUrl(image, 'image url'));
  const card = {
    title,
    description,
    url,
    color: color?.toLowerCase() ?? null,
    buttons,
    images,
    ...extras,
  };
  normalizeComponent(legacyComponent(card));
  return card;
}

function legacyComponent(card) {
  const title = card.title.replace(/([\\*_\x60~|[\]<>#])/g, '\\$1');
  const components = [
    { type: 10, content: `## ${title}${card.description ? '\n' + card.description : ''}` },
  ];
  if (card.images.length)
    components.push({ type: 12, items: card.images.map((url) => ({ media: { url } })) });
  if (card.buttons.length) {
    components.push({ type: 14, spacing: 1 });
    components.push({
      type: 1,
      components: card.buttons.map((button) => ({
        type: 2,
        style: 5,
        label: button.label,
        url: button.url,
      })),
    });
  }
  return {
    type: 17,
    accent_color: card.color === null ? null : parseInt(card.color.slice(1), 16),
    components,
  };
}

export function cardComponents(card) {
  return [
    'component' in card ? card.component : legacyComponent(card),
    ...(card.additional_cards || []),
  ];
}

export function selectedEmbedIndex(card) {
  let roots;
  try {
    roots = cardComponents(card);
  } catch {
    return -1;
  }
  return Number.isInteger(card.embed_card) && roots[card.embed_card]?.type === 17
    ? card.embed_card
    : roots.findIndex((root) => root?.type === 17);
}

export function buildEmbed(card) {
  return { component: cardComponents(card)[selectedEmbedIndex(card)] };
}

export function seoMetadata(card) {
  let component;
  try {
    component = buildEmbed(card).component;
  } catch {}
  const nodes = Array.isArray(component?.components) ? component.components : [];
  const content =
    nodes
      .flatMap((node) =>
        node?.type === 9 && Array.isArray(node.components) ? node.components : [node],
      )
      .find((node) => node?.type === 10 && typeof node.content === 'string')?.content || '';
  const automatic = content
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[\s#>*-]+/gm, '')
    .replace(/[*_\x60~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    title:
      (typeof card?.seo?.title === 'string' && card.seo.title.trim()) ||
      (typeof card?.title === 'string' ? card.title : ''),
    description: (typeof card?.description === 'string' && card.description.trim()) || automatic,
    image:
      (typeof card?.seo?.image === 'string' && card.seo.image.trim()) ||
      componentImages(component).find((image) => !/\.(mp4|webm|mov)(?:$|[?#])/i.test(image)) ||
      '',
  };
}

function serialize(embed) {
  return JSON.stringify(embed, (key, value) => {
    if (key === 'type' && (typeof value !== 'number' || !Object.hasOwn(fields, value)))
      throw new ValidationError('component type is not allowed here.');
    return key === 'emoji' ? normalizeEmojiPresentation(value) : value;
  }).replace(/</g, '\\u003c');
}

function checkBytes(embed) {
  if (new TextEncoder().encode(serialize(embed)).length > MAX_BYTES) {
    throw new ValidationError(
      'card exceeds discord’s 3,000-byte limit. shorten text or remove a link or image.',
    );
  }
}

export function embedJson(card) {
  return serialize(buildEmbed(card));
}

export function payloadBytes(card) {
  return new TextEncoder().encode(serialize(buildEmbed(card))).length;
}

export function embedScript(card) {
  return (
    '<script id="discord:component-embed" type="application/json">' + embedJson(card) + '</script>'
  );
}
