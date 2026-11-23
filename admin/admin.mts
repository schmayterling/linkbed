import { icon, mountIcons } from './icons.mts';
import { normalizeSlug, normalizeCustomBadges, MAX_CUSTOM_BADGES } from './model.mts';
import type { CustomBadge } from './model.mts';

const kinds = ['reports', 'links', 'fingerprints', 'tokens', 'slugs'] as const;
type Kind = (typeof kinds)[number];

type CardRow = {
  slug: string;
  title: string | null;
  link: string;
  banned: 0 | 1;
  token_hash: string | null;
  creator_fingerprint: string | null;
  verified_at: number | null;
  sponsored_at: number | null;
  customBadges: CustomBadge[];
};
type AdminItems = {
  reports: CardRow & {
    id: number;
    reason: string | null;
    details: string | null;
    reporter_fingerprint: string | null;
    created_at: number;
    removed: 0 | 1;
  };
  links: CardRow & { destination: string | null; updated_at: number };
  fingerprints: {
    fingerprint: string;
    created_at: number;
    banned_at: number | null;
    reporting_banned_at: number | null;
    identities: number;
  };
  tokens: { token_hash: string; created_at: number; revoked_at: number | null; cards: number };
  slugs: { slug: string; banned_at: number };
};
type AdminRow = { [K in Kind]: [kind: K, item: AdminItems[K]] }[Kind];
type RowAction = [label: string, run: () => void | Promise<void>, danger?: boolean];
type Confirmation = [message: string, label: string];

function required<T extends HTMLElement>(selector: string, elementType: new () => T): T {
  const node = document.querySelector(selector);
  if (!(node instanceof elementType)) throw new Error('missing ' + selector);
  return node;
}

const offsets: Record<Kind, number> = {
  reports: 0,
  links: 0,
  fingerprints: 0,
  tokens: 0,
  slugs: 0,
};
const lists: Record<Kind, string> = {
  links: 'link-list',
  reports: 'report-list',
  tokens: 'token-list',
  fingerprints: 'fingerprint-list',
  slugs: 'slug-list',
};
const empty: Record<Kind, string> = {
  links: 'no links match your search.',
  reports: 'all caught up. no reports need review.',
  tokens: 'no access tokens created yet.',
  fingerprints: 'fingerprints appear when visitors create cards or report a link.',
  slugs: 'no slugs are banned.',
};
const dialog = required('#admin-confirm', HTMLDialogElement);
const menu = required('#admin-menu', HTMLDivElement);
const workspace = required('.admin-workspace', HTMLDivElement);
const adminStatus = required('#admin-status', HTMLParagraphElement);
const refreshButton = required('#refresh-admin', HTMLButtonElement);
let busy = false,
  query = '',
  menuTrigger: HTMLButtonElement | undefined;
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
const shortHash = (value?: string | null): string =>
  value ? value.slice(0, 8) + '…' + value.slice(-4) : 'not recorded';
const date = (value: number): string =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch('/api/admin/' + path, {
    ...options,
    headers: { 'content-type': 'application/json' },
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    if (
      data &&
      typeof data === 'object' &&
      'error' in data &&
      typeof data.error === 'string' &&
      data.error
    )
      throw new Error(data.error);
    throw new Error('request failed.');
  }
  return data;
}
const badgeDialog = required('#admin-badge-dialog', HTMLDialogElement);
const badgeList = required('#admin-badge-list', HTMLDivElement);
const badgeError = required('#admin-badge-error', HTMLParagraphElement);
const addBadgeButton = required('#admin-add-badge', HTMLButtonElement);
const badgeForm = required('#admin-badge-form', HTMLFormElement);
let badgeSlug = '';
function addBadgeRow(badge: Partial<CustomBadge> = {}) {
  const row = element('div', undefined, 'admin-custom-badge');
  for (const [key, label, max] of [
    ['name', 'name', 80],
    ['image', 'image url', 2048],
  ] as const) {
    const group = element('div', undefined, 'composer-field');
    const input = element('input');
    input.id = 'badge-' + crypto.randomUUID();
    input.type = key === 'image' ? 'url' : 'text';
    input.dataset.badgeField = key;
    input.value = badge[key] || '';
    input.maxLength = max;
    input.required = true;
    const caption = element('label', label);
    caption.htmlFor = input.id;
    group.append(caption, input);
    row.append(group);
  }
  const remove = element('button', 'remove badge', 'text-button');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    row.remove();
    syncBadgeLimit();
  });
  row.append(remove);
  badgeList.append(row);
  syncBadgeLimit();
  return row;
}
function syncBadgeLimit() {
  addBadgeButton.disabled = busy || badgeList.children.length >= MAX_CUSTOM_BADGES;
}
function editBadges(item: AdminItems['links']) {
  if (busy) return;
  badgeSlug = item.slug;
  required('#admin-badge-card', HTMLParagraphElement).textContent = '/' + item.slug;
  badgeError.textContent = '';
  badgeList.replaceChildren();
  for (const badge of item.customBadges?.length ? item.customBadges : [{}]) addBadgeRow(badge);
  badgeDialog.showModal();
  badgeDialog.querySelector('input')?.focus();
}
addBadgeButton.addEventListener('click', () => {
  if (!busy && badgeList.children.length < MAX_CUSTOM_BADGES) {
    addBadgeRow().querySelector('input')?.focus();
  }
});
for (const button of badgeDialog.querySelectorAll('[data-close-badges]'))
  button.addEventListener('click', () => {
    if (!busy) badgeDialog.close();
  });
badgeDialog.addEventListener('cancel', (event) => {
  if (busy) event.preventDefault();
});
badgeDialog.addEventListener('close', () => badgeList.replaceChildren());
badgeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !badgeForm.reportValidity()) return;
  let badges: CustomBadge[];
  try {
    badges = normalizeCustomBadges(
      [...badgeList.children].map((row) =>
        Object.fromEntries(
          [...row.querySelectorAll('input')].map((input) => [
            String(input.dataset.badgeField),
            input.value,
          ]),
        ),
      ),
    );
  } catch (error) {
    badgeError.textContent = messageOf(error);
    return;
  }
  setBusy(true);
  badgeError.textContent = '';
  try {
    await api('cards/' + badgeSlug + '/badges', {
      method: 'PUT',
      body: JSON.stringify({ badges }),
    });
    await renderLists();
    badgeDialog.close();
    adminStatus.textContent = 'custom badges saved.';
  } catch (error) {
    badgeError.textContent = messageOf(error);
  } finally {
    setBusy(false);
    syncBadgeLimit();
  }
});
function openLink(value: string, label: string) {
  const node = element('a', label);
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol)) {
      node.href = url.href;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    }
  } catch {
    // Leave the anchor without an href when the URL cannot be parsed.
  }
  return node;
}
function status(label: string, danger = false) {
  return element('span', label, 'admin-badge' + (danger ? ' is-danger' : ''));
}
function setBusy(value: boolean) {
  busy = value;
  workspace.setAttribute('aria-busy', String(value));
  if (value)
    document.querySelectorAll('button, input').forEach((node) => {
      if (node instanceof HTMLButtonElement || node instanceof HTMLInputElement) {
        node.dataset.wasDisabled = String(node.disabled);
        node.disabled = true;
      }
    });
  else
    document.querySelectorAll('[data-was-disabled]').forEach((node) => {
      if (node instanceof HTMLButtonElement || node instanceof HTMLInputElement) {
        node.disabled = node.dataset.wasDisabled === 'true';
        delete node.dataset.wasDisabled;
      }
    });
}
function confirmAction(message: string, label: string): Promise<boolean> {
  required('#confirm-heading', HTMLHeadingElement).textContent = label + '?';
  required('#confirm-note', HTMLParagraphElement).textContent = message;
  required('#confirm-action', HTMLButtonElement).textContent = label;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {
      once: true,
    }),
  );
}
async function mutate(
  path: string,
  method: 'POST' | 'DELETE',
  message: string,
  confirmation?: Confirmation | null,
) {
  if (busy || dialog.open) return;
  if (confirmation && !(await confirmAction(...confirmation))) return;
  setBusy(true);
  adminStatus.textContent = '';
  try {
    await api(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
    await renderLists();
    adminStatus.textContent = message;
  } catch (error) {
    adminStatus.textContent = messageOf(error);
  } finally {
    setBusy(false);
    if (!document.activeElement || document.activeElement === document.body) refreshButton.focus();
  }
}
function banCreator(fingerprint: string, label = 'ban creator') {
  return mutate(
    'fingerprints/' + fingerprint + '/ban',
    'POST',
    'identity banned and linked tokens revoked.',
    [
      'this identity will no longer create or edit cards, or submit reports. linked access tokens will be permanently revoked.',
      label,
    ],
  );
}
function reportingBan(fingerprint: string, unban = false) {
  return mutate(
    'fingerprints/' + fingerprint + (unban ? '/unban-reporting' : '/ban-reporting'),
    'POST',
    unban ? 'reporting unbanned.' : 'reporting banned.',
    unban
      ? null
      : [
          'this identity will no longer submit reports. card creation stays available.',
          'ban reporting',
        ],
  );
}
function revokeToken(hash: string) {
  return mutate('tokens/' + hash + '/revoke', 'POST', 'token revoked.', [
    'this token will no longer sign in. all its active sessions will be ended.',
    'revoke token',
  ]);
}
function rowActions(actions: RowAction[], label: string) {
  const cell = element('td', undefined, 'admin-action-cell');
  if (!actions.length) return cell;
  const trigger = element('button', 'actions', 'button secondary small');
  trigger.append(icon('chevron-down'));
  trigger.type = 'button';
  trigger.setAttribute('aria-label', 'actions for ' + label);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.addEventListener('click', () => {
    if (busy) return;
    if (menu.matches(':popover-open')) {
      menu.hidePopover();
      if (menuTrigger === trigger) return;
    }
    menuTrigger = trigger;
    menu.replaceChildren(
      ...actions.map(([label, run, danger]) => {
        const button = element('button', label, danger ? 'admin-danger' : '');
        button.type = 'button';
        button.addEventListener('click', () => {
          menu.hidePopover();
          trigger.focus();
          void run();
        });
        return button;
      }),
    );
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.showPopover();
    trigger.setAttribute('aria-expanded', 'true');
    const rect = trigger.getBoundingClientRect(),
      height = menu.offsetHeight;
    const above = rect.bottom + height + 8 > innerHeight && rect.top > height + 8;
    menu.toggleAttribute('data-opens-above', above);
    menu.style.left =
      Math.max(12, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 12)) +
      'px';
    menu.style.top = Math.max(12, above ? rect.top - height - 6 : rect.bottom + 6) + 'px';
    menu.querySelector('button')?.focus();
  });
  if (busy) {
    trigger.disabled = true;
    trigger.dataset.wasDisabled = 'false';
  }
  cell.append(trigger);
  return cell;
}
menu.addEventListener('toggle', (event) => {
  if (event.newState === 'closed') menuTrigger?.setAttribute('aria-expanded', 'false');
});
menu.addEventListener('keydown', (event) => {
  const buttons = [...menu.querySelectorAll('button')],
    index = buttons.findIndex((button) => button === document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    menu.hidePopover();
    menuTrigger?.focus();
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    buttons[
      (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    ]?.focus();
  }
});
function renderRow([kind, item]: AdminRow) {
  const row = element('tr');
  const actions: RowAction[] = [];
  const cell = (...children: HTMLElement[]) => {
    const td = element('td');
    td.append(...children);
    row.append(td);
  };
  if (kind === 'tokens') {
    cell(element('code', shortHash(item.token_hash)));
    cell(status(item.revoked_at ? 'revoked' : 'active', !!item.revoked_at));
    cell(element('span', String(item.cards)));
    cell(element('time', date(item.created_at)));
    if (!item.revoked_at) actions.push(['revoke token', () => revokeToken(item.token_hash), true]);
  } else if (kind === 'fingerprints') {
    cell(element('code', shortHash(item.fingerprint)));
    cell(
      status(
        item.banned_at ? 'fully banned' : item.reporting_banned_at ? 'reporting banned' : 'active',
        !!(item.banned_at || item.reporting_banned_at),
      ),
    );
    cell(element('span', String(item.identities)));
    cell(element('time', date(item.created_at)));
    actions.push(
      item.banned_at
        ? [
            'unban identity',
            () =>
              mutate(
                'fingerprints/' + item.fingerprint + '/unban',
                'POST',
                'identity unbanned. revoked tokens stay revoked.',
              ),
          ]
        : ['ban identity entirely', () => banCreator(item.fingerprint), true],
    );
    actions.push([
      item.reporting_banned_at ? 'unban reporting' : 'ban reporting',
      () => reportingBan(item.fingerprint, !!item.reporting_banned_at),
      !item.reporting_banned_at,
    ]);
  } else if (kind === 'slugs') {
    cell(element('code', '/' + item.slug));
    cell(element('time', date(item.banned_at)));
    actions.push([
      'unban slug',
      () => mutate('slugs/' + item.slug + '/unban', 'POST', 'slug unbanned.'),
    ]);
  } else {
    const title = element('strong', item.title || '/' + item.slug, 'admin-card-name');
    cell(
      title,
      ...(item.verified_at != null ? [status('verified')] : []),
      ...(item.sponsored_at != null ? [status('sponsor')] : []),
      ...(item.customBadges || []).map((badge) => status(badge.name)),
      ...(kind === 'reports'
        ? [
            element('p', item.reason || 'reason not recorded', 'muted'),
            ...(item.details ? [element('p', item.details)] : []),
          ]
        : []),
      openLink(item.link, '/' + item.slug),
      ...(kind === 'links'
        ? [
            item.destination
              ? openLink(item.destination, item.destination)
              : element('span', 'none', 'muted'),
          ]
        : []),
    );
    if (kind === 'reports') {
      cell(element('code', shortHash(item.reporter_fingerprint)));
      cell(element('time', date(item.created_at)));
      actions.push([
        'dismiss report',
        () => mutate('reports/' + item.id + '/dismiss', 'POST', 'report dismissed.'),
      ]);
      const reporter = item.reporter_fingerprint;
      if (reporter)
        actions.push(
          ['ban reporter from reporting', () => reportingBan(reporter), true],
          ['ban reporter entirely', () => banCreator(reporter, 'ban reporter entirely'), true],
        );
    } else {
      cell(element('code', shortHash(item.creator_fingerprint)));
      cell(status(item.banned ? 'banned' : 'live', !!item.banned));
      cell(element('time', date(item.updated_at)));
      actions.push(
        [
          item.verified_at != null ? 'remove verified badge' : 'mark as verified',
          () =>
            mutate(
              'cards/' + item.slug + '/verify',
              item.verified_at != null ? 'DELETE' : 'POST',
              item.verified_at != null ? 'verified badge removed.' : 'verified badge added.',
            ),
        ],
        ['custom badges', () => editBadges(item)],
      );
      actions.push([
        item.sponsored_at != null ? 'remove sponsor badge' : 'mark as sponsor',
        () =>
          mutate(
            'cards/' + item.slug + '/sponsor',
            item.sponsored_at != null ? 'DELETE' : 'POST',
            item.sponsored_at != null ? 'sponsor badge removed.' : 'sponsor badge added.',
          ),
      ]);
    }
    if (kind === 'links' || !item.removed) {
      const creator = item.creator_fingerprint;
      const token = item.token_hash;
      if (creator) actions.push(['ban creator', () => banCreator(creator), true]);
      if (token) actions.push(['revoke creator token', () => revokeToken(token), true]);
      actions.push([
        item.banned ? 'unban slug' : 'ban slug',
        () =>
          mutate(
            'slugs/' + item.slug + (item.banned ? '/unban' : '/ban'),
            'POST',
            item.banned ? 'slug unbanned.' : 'slug banned.',
            item.banned
              ? null
              : ['/' + item.slug + ' will be unavailable until unbanned.', 'ban slug'],
          ),
        !item.banned,
      ]);
      actions.push([
        'delete card',
        () =>
          mutate('cards/' + item.slug, 'DELETE', 'card deleted.', [
            '/' +
              item.slug +
              ' will stop working. all pending reports for this link will be resolved.',
            'delete card',
          ]),
        true,
      ]);
    }
  }
  const label =
    'slug' in item
      ? item.slug
      : shortHash('fingerprint' in item ? item.fingerprint : item.token_hash);
  row.append(rowActions(actions, label));
  return row;
}
async function renderList(kind: Kind) {
  let items: unknown[];
  let hasMore: boolean;
  for (;;) {
    const params = new URLSearchParams({
      offset: String(offsets[kind]),
      q: kind === 'links' ? query : '',
    });
    const data = await api((kind === 'links' ? 'cards' : kind) + '?' + params);
    if (
      !data ||
      typeof data !== 'object' ||
      !('items' in data) ||
      !Array.isArray(data.items) ||
      !('hasMore' in data) ||
      typeof data.hasMore !== 'boolean'
    )
      throw new Error('request failed.');
    ({ items, hasMore } = data);
    if (items.length || !offsets[kind]) break;
    offsets[kind] -= 50;
  }
  const list = required('#' + lists[kind], HTMLTableSectionElement);
  const rows = items.map((item) => {
    // Each handler.ts list query supplies the fields for its matching route.
    return renderRow([kind, item] as AdminRow);
  });
  if (!rows.length) {
    const row = element('tr'),
      td = element('td', empty[kind], 'admin-empty');
    const table = list.closest('table');
    if (!table) throw new Error('missing table for ' + kind);
    td.colSpan = table.querySelectorAll('th').length;
    row.append(td);
    rows.push(row);
  }
  list.replaceChildren(...rows);
  for (const [direction, disabled] of [
    ['previous', offsets[kind] === 0],
    ['next', !hasMore],
  ] as const) {
    const button = required('#' + kind + '-' + direction, HTMLButtonElement);
    button.disabled = busy || disabled;
    if (busy) button.dataset.wasDisabled = String(disabled);
  }
  required('#' + kind + '-count', HTMLSpanElement).textContent =
    items.length + (hasMore ? '+' : '') + ' shown';
  required('#' + kind + '-page', HTMLSpanElement).textContent = 'page ' + (offsets[kind] / 50 + 1);
}
async function renderLists() {
  for (const kind of kinds) await renderList(kind);
}
async function refresh() {
  if (busy) return;
  setBusy(true);
  adminStatus.textContent = '';
  try {
    await renderLists();
  } catch (error) {
    adminStatus.textContent = messageOf(error);
  } finally {
    setBusy(false);
  }
}
const tabs = [...document.querySelectorAll('.admin-tabs [role="tab"]')].filter(
  (node) => node instanceof HTMLButtonElement,
);
function selectTab(tab: HTMLButtonElement) {
  tabs.forEach((button) => {
    const selected = tab === button;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    const panelId = button.getAttribute('aria-controls');
    if (panelId === null) throw new Error('missing aria-controls on ' + button.id);
    required('#' + panelId, HTMLElement).hidden = !selected;
  });
  if (menu.matches(':popover-open')) menu.hidePopover();
  history.replaceState(null, '', '#' + tab.id.replace('-tab', ''));
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    let next: HTMLButtonElement | undefined;
    switch (event.key) {
      case 'ArrowRight':
        next = tabs[(index + 1) % tabs.length];
        break;
      case 'ArrowLeft':
        next = tabs[(index + tabs.length - 1) % tabs.length];
        break;
      case 'Home':
        next = tabs[0];
        break;
      case 'End':
        next = tabs.at(-1);
        break;
    }
    if (next && !busy) {
      event.preventDefault();
      selectTab(next);
      next.focus();
    }
  });
});
refreshButton.addEventListener('click', () => void refresh());
required('#admin-search', HTMLFormElement).addEventListener('submit', (event) => {
  event.preventDefault();
  if (!busy) {
    query = required('#admin-query', HTMLInputElement).value.trim();
    offsets.links = 0;
    void refresh();
  }
});
for (const kind of kinds)
  for (const [direction, change] of [
    ['previous', -50],
    ['next', 50],
  ] as const) {
    required('#' + kind + '-' + direction, HTMLButtonElement).addEventListener('click', () => {
      if (!busy) {
        offsets[kind] = Math.max(0, offsets[kind] + change);
        void refresh();
      }
    });
  }
required('#ban-slug-form', HTMLFormElement).addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  try {
    const slug = normalizeSlug(required('#ban-slug-value', HTMLInputElement).value.trim());
    await mutate('slugs/' + slug + '/ban', 'POST', 'slug banned.', [
      '/' + slug + ' will be unavailable until unbanned.',
      'ban slug',
    ]);
  } catch (error) {
    adminStatus.textContent = messageOf(error);
  }
});
dialog.setAttribute('closedby', 'any');
if (!Reflect.has(dialog, 'closedBy')) {
  let pressedOutside = false;
  const outside = (event: MouseEvent) => {
    const rect = dialog.getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  };
  dialog.addEventListener('pointerdown', (event) => {
    pressedOutside = event.target === dialog && outside(event);
  });
  dialog.addEventListener('click', (event) => {
    if (pressedOutside && event.target === dialog && outside(event)) dialog.close('cancel');
    pressedOutside = false;
  });
}
const themeToggle = required('#theme-toggle', HTMLButtonElement);
function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme;
  themeToggle.replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon'));
  themeToggle.setAttribute(
    'aria-label',
    'switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode',
  );
}
let theme;
try {
  theme = localStorage.getItem('theme');
} catch {}
applyTheme(theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem('theme', next);
  } catch {}
});
window.addEventListener(
  'scroll',
  () => {
    if (menu.matches(':popover-open')) menu.hidePopover();
  },
  { passive: true },
);
window.addEventListener('resize', () => {
  if (menu.matches(':popover-open')) menu.hidePopover();
});
mountIcons();
const initialTab = document.getElementById(location.hash.slice(1) + '-tab');
selectTab(
  initialTab instanceof HTMLButtonElement
    ? initialTab
    : required('#reports-tab', HTMLButtonElement),
);
void refresh();
