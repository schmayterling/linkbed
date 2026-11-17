import {
  MAX_CARDS,
  buildEmbed,
  normalizeCard,
  normalizeComponent,
  normalizeEmbedCard,
  publicHttpUrl,
  ValidationError,
} from './model.mjs';

const invalid = (message) => {
  throw new ValidationError(message);
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const literal = (value) => String(value).replace(/([\\*_`~|[\]<>#])/g, '\\$1');
const text = (content) => ({ type: 10, content });
const nonempty = (value) => typeof value === 'string' && value.trim();

function normalizeRoots(components) {
  if (!Array.isArray(components) || !components.length || components.length > MAX_CARDS)
    invalid(`import one to ${MAX_CARDS} card containers.`);
  return components.map(normalizeComponent);
}

function componentCard(components, embed_card) {
  const [component, ...additional_cards] = normalizeRoots(components);
  const selected = normalizeEmbedCard(embed_card, additional_cards.length + 1);
  return {
    component,
    ...(additional_cards.length ? { additional_cards } : {}),
    ...(selected !== null ? { embed_card: selected } : {}),
  };
}

export function linkedEmbedCode(pageUrl, sourceUrl) {
  const href = publicHttpUrl(
    new URL('/linkbed.json', pageUrl || 'https://your-site.com/').href,
    'website url',
  );
  const escaped = href.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return {
    head: '<link rel="discord:component-embed" type="application/json" href="' + escaped + '">',
    route: `export async function GET() {
  const headers = { "cache-control": "no-store" };
  try {
    const upstream = await fetch(${JSON.stringify(sourceUrl)}, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!upstream.ok || !upstream.body) throw new Error("embed unavailable");
    const reader = upstream.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 3000) throw new Error("embed too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const body = Buffer.concat(chunks).toString("utf8");
    if (JSON.parse(body)?.component?.type !== 17) throw new Error("invalid embed");
    return new Response(body, {
      headers: { ...headers, "content-type": "application/json; charset=utf-8" },
    });
  } catch {
    return new Response(null, { status: 502, headers });
  }
}
`,
  };
}

function richEmbed(embed) {
  if (!object(embed)) invalid('invalid embed.');
  if (embed.type && embed.type !== 'rich')
    invalid('only rich or component embeds can be imported.');
  if (embed.video || embed.provider)
    invalid('video/provider embeds cannot be converted. use a gallery.');
  const components = [];
  const add = (value) => {
    if (nonempty(value)) components.push(text(value));
  };
  if (embed.author) {
    if (!object(embed.author) || embed.author.url) invalid('linked authors cannot be converted.');
    if (embed.author.icon_url) {
      components.push({
        type: 9,
        components: [text(literal(embed.author.name || 'author'))],
        accessory: { type: 11, media: { url: embed.author.icon_url } },
      });
    } else add(nonempty(embed.author.name) ? literal(embed.author.name) : '');
  }
  if (embed.title) {
    const title = literal(embed.title);
    const url = embed.url
      ? publicHttpUrl(embed.url).replace(/\(/g, '%28').replace(/\)/g, '%29')
      : '';
    add('## ' + (url ? '[' + title + '](' + url + ')' : title));
  } else if (embed.url) invalid('an embed url needs a title.');
  add(embed.description);
  if (embed.fields !== undefined) {
    if (!Array.isArray(embed.fields)) invalid('embed fields must be an array.');
    for (const field of embed.fields) {
      if (!object(field) || !nonempty(field.name) || !nonempty(field.value))
        invalid('each field needs a name and value.');
      add('**' + literal(field.name) + '**\n' + field.value);
    }
  }
  if (embed.thumbnail?.url) {
    const firstText = components.findIndex((component) => component.type === 10);
    if (firstText < 0) invalid('a thumbnail needs some text.');
    components[firstText] = {
      type: 9,
      components: [components[firstText]],
      accessory: { type: 11, media: { url: embed.thumbnail.url } },
    };
  }
  if (embed.image?.url) components.push({ type: 12, items: [{ media: { url: embed.image.url } }] });
  if (embed.footer?.icon_url) {
    components.push({
      type: 9,
      components: [text(literal(embed.footer.text || 'footer'))],
      accessory: { type: 11, media: { url: embed.footer.icon_url } },
    });
  } else add(nonempty(embed.footer?.text) ? '-# ' + literal(embed.footer.text) : '');
  if (embed.timestamp) {
    const seconds = Math.floor(new Date(embed.timestamp).getTime() / 1000);
    if (!Number.isFinite(seconds) || seconds < 0) invalid('invalid embed timestamp.');
    add('<t:' + seconds + ':f>');
  }
  return {
    type: 17,
    components,
    ...(embed.color !== undefined ? { accent_color: embed.color } : {}),
  };
}

export function importCardJson(value) {
  let data = typeof value === 'string' ? JSON.parse(value) : value;
  if (!object(data)) invalid('paste a component or message json object.');
  if ('backups' in data) {
    if (!Array.isArray(data.backups) || data.backups.length !== 1)
      invalid('import one backup at a time.');
    data = data.backups[0];
  }
  if (!object(data)) invalid('invalid backup json.');
  if ('messages' in data) {
    if (!Array.isArray(data.messages) || data.messages.length !== 1)
      invalid('import one message at a time.');
    data = data.messages[0]?.data ?? data.messages[0];
  }
  if (!object(data)) invalid('invalid message json.');
  if ('component' in data) {
    const card = normalizeCard({ title: 'imported card', ...data });
    delete card.buttons;
    delete card.images;
    for (const key of ['title', 'description', 'url', 'color']) {
      if (!(key in data)) delete card[key];
    }
    return card;
  }
  if (data.type === 17) return componentCard([data]);
  if (data.type === 'rich' || 'title' in data || 'description' in data) data = { embeds: [data] };
  if (data.attachments?.length || data.files?.length || data.poll || data.sticker_ids?.length)
    invalid('attachments, polls, and stickers cannot be imported into a link card.');
  const embeds = data.embeds ?? [];
  if (!Array.isArray(embeds) || embeds.length > 1) invalid('import one embed at a time.');
  if (embeds[0]?.type === 'components') {
    if (
      data.content ||
      (data.components !== undefined && (!Array.isArray(data.components) || data.components.length))
    )
      invalid('import card containers without additional content.');
    return componentCard(embeds[0].components);
  }
  const roots = embeds.map(richEmbed);
  const blocks = roots.flatMap((root) => root.components);
  if (nonempty(data.content)) blocks.unshift(text(data.content));
  if (data.content != null && typeof data.content !== 'string')
    invalid('message content must be text.');
  if (data.components !== undefined) {
    if (!Array.isArray(data.components)) invalid('components must be an array.');
    for (const component of data.components) {
      if (component?.type === 17) roots.push(component);
      else blocks.push(component);
    }
  }
  if (data.components?.some((component) => component?.type === 17)) {
    if (embeds.length || blocks.length)
      invalid('import card containers without additional content.');
    return componentCard(roots);
  }
  const component = normalizeComponent({
    type: 17,
    components: blocks,
    ...(roots[0]?.accent_color !== undefined ? { accent_color: roots[0].accent_color } : {}),
  });
  const first = embeds[0];
  return {
    component,
    ...(nonempty(first?.title) ? { title: first.title } : {}),
    ...(nonempty(first?.description) ? { description: first.description } : {}),
    ...(nonempty(first?.url) ? { url: first.url } : {}),
  };
}

export function messageJson(card) {
  const components = [normalizeComponent(buildEmbed(card).component)];
  return JSON.stringify(
    {
      flags: 32768,
      components,
      allowed_mentions: { parse: [] },
    },
    null,
    2,
  );
}
