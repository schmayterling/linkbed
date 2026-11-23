import { icon } from './icons.mts';
import type { default as EmojiDatabase, NativeEmoji } from './vendor/emoji-database.mjs';
import type PickerElement from './vendor/emoji-picker.mjs';

let panel: HTMLDivElement | undefined,
  picker: PickerElement | null | undefined,
  target: HTMLInputElement | undefined,
  trigger: HTMLButtonElement | undefined,
  loading: Promise<void> | null | undefined;
let suggestionPanel: HTMLDivElement | undefined,
  suggestionInput: HTMLInputElement | undefined,
  database: Promise<EmojiDatabase> | undefined,
  searchVersion = 0,
  suggestions: NativeEmoji[] = [],
  selected = 0;

function closeSuggestions(): void {
  searchVersion++;
  if (suggestionPanel?.matches(':popover-open')) suggestionPanel.hidePopover();
  suggestionInput?.setAttribute('aria-expanded', 'false');
  suggestionInput?.removeAttribute('aria-activedescendant');
}

function chooseSuggestion(index: number): void {
  const value = suggestions[index];
  if (!value || !suggestionInput?.isConnected) return;
  const input = suggestionInput;
  closeSuggestions();
  input.value = value.unicode;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus({ preventScroll: true });
}

function positionSuggestions(): void {
  if (!suggestionPanel || !suggestionInput?.isConnected) return closeSuggestions();
  const rect = suggestionInput.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > innerHeight) return closeSuggestions();
  const width = Math.min(320, innerWidth - 24),
    height = suggestions.length * 40 + 12;
  suggestionPanel.style.width = width + 'px';
  suggestionPanel.style.left = Math.max(12, Math.min(rect.left, innerWidth - width - 12)) + 'px';
  const top = Math.max(
    12,
    rect.bottom + height + 6 <= innerHeight ? rect.bottom + 6 : rect.top - height - 6,
  );
  suggestionPanel.style.top = top + 'px';
  suggestionPanel.toggleAttribute('data-opens-above', top < rect.top);
}

export function autocompleteEmoji(input: HTMLInputElement): void {
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'emoji-suggestions');
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';
  input.addEventListener('input', async () => {
    const query = input.value.trim();
    if (!/^:?[a-z0-9_+-]{2,}:?$/i.test(query)) return closeSuggestions();
    const version = ++searchVersion;
    try {
      database ||= import('./vendor/emoji-database.mjs').then(
        ({ default: Database }) => new Database({ dataSource: '/vendor/emoji-data.json' }),
      );
      const results = await (await database).getEmojiBySearchQuery(query.replace(/^:|:$/g, ''));
      if (version !== searchVersion || !input.isConnected || document.activeElement !== input)
        return;
      const term = query.replace(/^:|:$/g, '').toLowerCase();
      const rank = (value: NativeEmoji) =>
        value.shortcodes?.includes(term)
          ? 0
          : value.shortcodes?.some((code) => code.startsWith(term))
            ? 1
            : 2;
      suggestions = results
        .filter((value): value is NativeEmoji => 'unicode' in value && !!value.unicode)
        .sort((a, b) => rank(a) - rank(b))
        .slice(0, 6);
      if (!suggestions.length) return closeSuggestions();
      if (!suggestionPanel) {
        const created = document.createElement('div');
        suggestionPanel = created;
        suggestionPanel.id = 'emoji-suggestions';
        suggestionPanel.className = 'emoji-suggestions';
        suggestionPanel.popover = 'auto';
        suggestionPanel.setAttribute('role', 'listbox');
        suggestionPanel.setAttribute('aria-label', 'emoji suggestions');
        document.body.append(suggestionPanel);
        suggestionPanel.addEventListener('pointerdown', (event) => event.preventDefault());
        suggestionPanel.addEventListener('toggle', (event) => {
          if (event.newState === 'closed' && !created.matches(':popover-open')) {
            suggestionInput?.setAttribute('aria-expanded', 'false');
            suggestionInput?.removeAttribute('aria-activedescendant');
          }
        });
        window.addEventListener(
          'scroll',
          () => {
            if (created.matches(':popover-open')) positionSuggestions();
          },
          { passive: true },
        );
        window.addEventListener('resize', () => {
          if (created.matches(':popover-open')) positionSuggestions();
        });
      }
      if (suggestionInput && suggestionInput !== input) {
        suggestionInput.setAttribute('aria-expanded', 'false');
        suggestionInput.removeAttribute('aria-activedescendant');
      }
      suggestionInput = input;
      selected = 0;
      suggestionPanel.replaceChildren(
        ...suggestions.map((value, index) => {
          const option = document.createElement('button');
          option.type = 'button';
          option.tabIndex = -1;
          option.id = 'emoji-suggestion-' + index;
          option.setAttribute('role', 'option');
          option.setAttribute('aria-selected', String(index === selected));
          const emoji = document.createElement('span');
          emoji.textContent = value.unicode;
          emoji.className = 'suggestion-emoji';
          const label = document.createElement('span');
          label.textContent = ':' + (value.shortcodes?.[0] || value.annotation) + ':';
          option.append(emoji, label);
          option.addEventListener('click', () => chooseSuggestion(index));
          return option;
        }),
      );
      positionSuggestions();
      if (!suggestionPanel.matches(':popover-open')) suggestionPanel.showPopover();
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-activedescendant', 'emoji-suggestion-0');
    } catch {
      closeSuggestions();
    }
  });
  input.addEventListener('blur', closeSuggestions);
  input.addEventListener('keydown', (event) => {
    if (suggestionInput !== input || !suggestionPanel?.matches(':popover-open')) return;
    if (!['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') return closeSuggestions();
    if (event.key === 'Enter') return chooseSuggestion(selected);
    selected =
      (selected + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
    [...suggestionPanel.children].forEach((option, index) =>
      option.setAttribute('aria-selected', String(index === selected)),
    );
    input.setAttribute('aria-activedescendant', 'emoji-suggestion-' + selected);
  });
}

function position(): void {
  if (!panel?.matches(':popover-open') || !trigger?.isConnected) return;
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(320, innerWidth - 24);
  const height = Math.min(352, innerHeight - 24);
  panel.style.width = width + 'px';
  panel.style.height = height + 'px';
  panel.style.left = Math.max(12, Math.min(rect.right - width, innerWidth - width - 12)) + 'px';
  const top =
    rect.bottom + 6 + height <= innerHeight - 12 ? rect.bottom + 6 : rect.top - height - 6;
  panel.style.top = Math.max(12, Math.min(top, innerHeight - height - 12)) + 'px';
  panel.toggleAttribute('data-opens-above', top < rect.top);
}

export async function openEmojiPicker(
  input: HTMLInputElement,
  button: HTMLButtonElement,
): Promise<void> {
  closeSuggestions();
  if (!panel) {
    const created = document.createElement('div');
    panel = created;
    panel.id = 'emoji-popover';
    panel.className = 'emoji-popover';
    panel.setAttribute('popover', 'auto');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'choose emoji');
    document.body.append(panel);
    panel.addEventListener('toggle', (event) => {
      trigger?.setAttribute('aria-expanded', String(event.newState === 'open'));
    });
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        created.hidePopover();
        trigger?.focus({ preventScroll: true });
      }
    });
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position);
  }
  if (panel.matches(':popover-open') && trigger === button) {
    panel.hidePopover();
    return;
  }
  trigger?.setAttribute('aria-expanded', 'false');
  target = input;
  trigger = button;
  panel.showPopover();
  button.setAttribute('aria-expanded', 'true');
  position();
  try {
    if (!picker) {
      if (!loading) panel.textContent = 'loading emoji…';
      const popover = panel;
      loading ||= import('./vendor/emoji-picker.mjs').then(async ({ default: Picker }) => {
        picker = new Picker({ dataSource: '/vendor/emoji-data.json' });
        const styles = document.createElement('link');
        styles.rel = 'stylesheet';
        styles.href = '/emoji-picker.css';
        picker.shadowRoot.append(styles);
        picker.addEventListener('emoji-click', (event) => {
          if (!target?.isConnected) return;
          target.value = event.detail.unicode ?? '';
          target.dispatchEvent(new Event('input', { bubbles: true }));
          popover.hidePopover();
          target.focus({ preventScroll: true });
        });
        const header = document.createElement('div');
        header.className = 'emoji-titlebar';
        const title = document.createElement('strong');
        title.textContent = 'emoji';
        const close = document.createElement('button');
        close.type = 'button';
        close.setAttribute('aria-label', 'close emoji picker');
        close.append(icon('x'));
        close.addEventListener('click', () => {
          popover.hidePopover();
          trigger?.focus({ preventScroll: true });
        });
        header.append(title, close);
        popover.replaceChildren(header, picker);
        await picker.database.ready();
        const search = picker.shadowRoot.querySelector<HTMLInputElement>('#search');
        if (!search) throw new Error('emoji picker has no #search input');
        search.placeholder = 'search emoji';
        const categories: Record<string, string> = {
          0: 'smile',
          1: 'hand',
          3: 'cat',
          4: 'apple',
          5: 'house',
          6: 'volleyball',
          7: 'lightbulb',
          8: 'heart',
          9: 'flag',
        };
        picker.shadowRoot.querySelectorAll<HTMLElement>('.nav-button').forEach((button) => {
          button
            .querySelector('.nav-emoji')
            ?.replaceChildren(icon(categories[button.dataset.groupId ?? '']));
        });
      });
      await loading;
    }
    if (!picker) throw new Error('emoji picker did not load');
    if (!panel.matches(':popover-open')) return;
    picker.className = document.documentElement.dataset.theme || 'light';
    picker.shadowRoot
      .querySelector<HTMLInputElement>('input[type="search"]')
      ?.focus({ preventScroll: true });
  } catch {
    picker = null;
    loading = null;
    panel.textContent = 'could not load emoji. close and try again.';
  }
}
