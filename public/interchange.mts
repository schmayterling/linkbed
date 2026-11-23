import {
  MAX_CARDS,
  buildEmbed,
  normalizeCard,
  normalizeComponent,
  normalizeEmbedCard,
  publicHttpUrl,
  ValidationError,
} from './model.mts';
import type { ContainerComponent, Page, PageCard, PageSource, TextComponent } from './model.mts';

export type ImportedCard = Partial<Omit<Page, 'component' | 'buttons' | 'images'>> & {
  component: PageCard;
};

type ObjectFields = Record<string, unknown>;

const invalid: (message: string) => never = (message) => {
  throw new ValidationError(message);
};
const object = (value: unknown): value is ObjectFields =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const literal = (value: unknown): string => String(value).replace(/([\\*_`~|[\]<>#])/g, '\\$1');
const text = (content: string): TextComponent => ({ type: 10, content });
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

function normalizeRoots(components: unknown): ContainerComponent[] {
  if (!Array.isArray(components) || !components.length || components.length > MAX_CARDS)
    invalid(`import one to ${MAX_CARDS} card containers.`);
  return components.map(normalizeComponent);
}

function componentCard(components: unknown, embed_card?: unknown): ImportedCard {
  const [component, ...additional_cards] = normalizeRoots(components);
  const selected = normalizeEmbedCard(embed_card, additional_cards.length + 1);
  return {
    component,
    ...(additional_cards.length ? { additional_cards } : {}),
    ...(selected !== null ? { embed_card: selected } : {}),
  };
}

export function linkedEmbedCode(
  pageUrl: string | URL | null | undefined,
  sourceUrl: string,
): { head: string; route: string } {
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

type EmbedSource = {
  type?: unknown;
  components?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
};

type RichEmbedSource = ObjectFields & {
  thumbnail?: { url?: unknown } | null;
  image?: { url?: unknown } | null;
  footer?: { icon_url?: unknown; text?: unknown } | null;
};

function richEmbed(value: unknown): { type: 17; components: unknown[]; accent_color?: unknown } {
  if (!object(value)) invalid('invalid embed.');
  const embed: RichEmbedSource = value;
  if (embed.type && embed.type !== 'rich')
    invalid('only rich or component embeds can be imported.');
  if (embed.video || embed.provider)
    invalid('video/provider embeds cannot be converted. use a gallery.');
  const components: (TextComponent | (ObjectFields & { type: 9 | 12 }))[] = [];
  const add = (value: unknown) => {
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
    const fields: unknown[] = embed.fields;
    for (const field of fields) {
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
    // Use the existing Date coercion before testing whether the parsed timestamp is valid.
    const seconds = Math.floor(
      new Date(embed.timestamp as string | number | Date).getTime() / 1000,
    );
    if (!Number.isFinite(seconds) || seconds < 0) invalid('invalid embed timestamp.');
    add('<t:' + seconds + ':f>');
  }
  return {
    type: 17,
    components,
    ...(embed.color !== undefined ? { accent_color: embed.color } : {}),
  };
}

export function importCardJson(value: unknown): ImportedCard {
  let data: unknown = typeof value === 'string' ? JSON.parse(value) : value;
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
    const messages: ({ data?: unknown } | null | undefined)[] = data.messages;
    data = messages[0]?.data ?? messages[0];
  }
  if (!object(data)) invalid('invalid message json.');
  if ('component' in data) {
    const card: Partial<Page> = normalizeCard({ title: 'imported card', ...data });
    delete card.buttons;
    delete card.images;
    const keys: ('title' | 'description' | 'url' | 'color')[] = [
      'title',
      'description',
      'url',
      'color',
    ];
    for (const key of keys) {
      if (!(key in data)) delete card[key];
    }
    // A native JSON card supplies its component to normalizeCard, and the deletions preserve it.
    return card as ImportedCard;
  }
  if (data.type === 17) return componentCard([data]);
  const message: ObjectFields & {
    attachments?: { length?: unknown } | null;
    files?: { length?: unknown } | null;
    sticker_ids?: { length?: unknown } | null;
  } = data.type === 'rich' || 'title' in data || 'description' in data ? { embeds: [data] } : data;
  if (
    message.attachments?.length ||
    message.files?.length ||
    message.poll ||
    message.sticker_ids?.length
  )
    invalid('attachments, polls, and stickers cannot be imported into a link card.');
  const embedValues = message.embeds ?? [];
  if (!Array.isArray(embedValues) || embedValues.length > 1) invalid('import one embed at a time.');
  const embeds: (EmbedSource | null | undefined)[] = embedValues;
  if (embeds[0]?.type === 'components') {
    if (
      message.content ||
      (message.components !== undefined &&
        (!Array.isArray(message.components) || message.components.length))
    )
      invalid('import card containers without additional content.');
    return componentCard(embeds[0].components);
  }
  const roots: { type?: unknown; components?: unknown; accent_color?: unknown }[] =
    embeds.map(richEmbed);
  const blocks: unknown[] = roots.flatMap((root) => root.components);
  if (nonempty(message.content)) blocks.unshift(text(message.content));
  if (message.content != null && typeof message.content !== 'string')
    invalid('message content must be text.');
  if (message.components !== undefined) {
    if (!Array.isArray(message.components)) invalid('components must be an array.');
    const components: ({ type?: unknown } | null | undefined)[] = message.components;
    for (const component of components) {
      if (component?.type === 17) roots.push(component);
      else blocks.push(component);
    }
  }
  const components: ({ type?: unknown } | null | undefined)[] | undefined = message.components;
  if (components?.some((component) => component?.type === 17)) {
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

export function messageJson(card: PageSource): string {
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
