import { renderComponent } from './components.mts';
import { $, element } from './editor-dom.mts';
import { icon } from './icons.mts';
import { buildEmbed } from './model.mts';
import type { Page, PageBadge } from './model.mts';

export type SavedCard = Page & { slug: string; sponsored: boolean; badges: PageBadge[] };

type SavedCardActions = {
  cardUrl: (slug: string) => string;
  openCard: (card: SavedCard) => void;
  deleteCard: (slug: string) => void;
  copy: (url: string) => void;
  newCard: () => void;
};

const savedCardPlural = new Intl.PluralRules('en');

export function renderSavedCards(
  cards: readonly SavedCard[],
  { cardUrl, openCard, deleteCard, copy, newCard }: SavedCardActions,
): void {
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
      remove.addEventListener('click', () => deleteCard(card.slug));
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
}
