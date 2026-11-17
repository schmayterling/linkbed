import { icon, mountIcons } from './icons.mjs';
import { normalizeSlug, normalizeCustomBadges, MAX_CUSTOM_BADGES } from './model.mjs';

const $ = (selector) => document.querySelector(selector);
const kinds = ['reports', 'links', 'fingerprints', 'tokens', 'slugs'];
const offsets = Object.fromEntries(kinds.map((kind) => [kind, 0]));
const lists = {
  links: 'link-list',
  reports: 'report-list',
  tokens: 'token-list',
  fingerprints: 'fingerprint-list',
  slugs: 'slug-list',
};
const empty = {
  links: 'no links match your search.',
  reports: 'all caught up. no reports need review.',
  tokens: 'no access tokens created yet.',
  fingerprints: 'fingerprints appear when visitors create cards or report a link.',
  slugs: 'no slugs are banned.',
};
const dialog = $('#admin-confirm'),
  menu = $('#admin-menu');
let busy = false,
  query = '',
  menuTrigger;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const shortHash = (value) => (value ? value.slice(0, 8) + '…' + value.slice(-4) : 'not recorded');
const date = (value) =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

async function api(path, options = {}) {
  const response = await fetch('/api/admin/' + path, {
    ...options,
    headers: { 'content-type': 'application/json' },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'request failed.');
  return data;
}
const badgeDialog = $('#admin-badge-dialog');
let badgeSlug = '';
function addBadgeRow(badge = {}) {
  const row = element('div', undefined, 'admin-custom-badge');
  for (const [key, label, max] of [
    ['name', 'name', 80],
    ['image', 'image url', 2048],
  ]) {
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
  $('#admin-badge-list').append(row);
  syncBadgeLimit();
}
function syncBadgeLimit() {
  $('#admin-add-badge').disabled =
    busy || $('#admin-badge-list').children.length >= MAX_CUSTOM_BADGES;
}
function editBadges(item) {
  if (busy) return;
  badgeSlug = item.slug;
  $('#admin-badge-card').textContent = '/' + item.slug;
  $('#admin-badge-error').textContent = '';
  $('#admin-badge-list').replaceChildren();
  for (const badge of item.customBadges?.length ? item.customBadges : [{}]) addBadgeRow(badge);
  badgeDialog.showModal();
  badgeDialog.querySelector('input')?.focus();
}
$('#admin-add-badge').addEventListener('click', () => {
  if (!busy && $('#admin-badge-list').children.length < MAX_CUSTOM_BADGES) {
    addBadgeRow();
    $('#admin-badge-list').lastElementChild.querySelector('input').focus();
  }
});
for (const button of badgeDialog.querySelectorAll('[data-close-badges]'))
  button.addEventListener('click', () => {
    if (!busy) badgeDialog.close();
  });
badgeDialog.addEventListener('cancel', (event) => {
  if (busy) event.preventDefault();
});
badgeDialog.addEventListener('close', () => $('#admin-badge-list').replaceChildren());
$('#admin-badge-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !event.target.reportValidity()) return;
  let badges;
  try {
    badges = normalizeCustomBadges(
      [...$('#admin-badge-list').children].map((row) =>
        Object.fromEntries(
          [...row.querySelectorAll('input')].map((input) => [
            input.dataset.badgeField,
            input.value,
          ]),
        ),
      ),
    );
  } catch (error) {
    $('#admin-badge-error').textContent = error.message;
    return;
  }
  setBusy(true);
  $('#admin-badge-error').textContent = '';
  try {
    await api('cards/' + badgeSlug + '/badges', {
      method: 'PUT',
      body: JSON.stringify({ badges }),
    });
    await renderLists();
    badgeDialog.close();
    $('#admin-status').textContent = 'custom badges saved.';
  } catch (error) {
    $('#admin-badge-error').textContent = error.message;
  } finally {
    setBusy(false);
    syncBadgeLimit();
  }
});
function openLink(value, label) {
  const node = element('a', label);
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol)) {
      node.href = url.href;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    }
  } catch {}
  return node;
}
function status(label, danger = false) {
  return element('span', label, 'admin-badge' + (danger ? ' is-danger' : ''));
}
function setBusy(value) {
  busy = value;
  $('.admin-workspace').setAttribute('aria-busy', String(value));
  if (value)
    document.querySelectorAll('button, input').forEach((node) => {
      node.dataset.wasDisabled = String(node.disabled);
      node.disabled = true;
    });
  else
    document.querySelectorAll('[data-was-disabled]').forEach((node) => {
      node.disabled = node.dataset.wasDisabled === 'true';
      delete node.dataset.wasDisabled;
    });
}
function confirmAction(message, label) {
  $('#confirm-heading').textContent = label + '?';
  $('#confirm-note').textContent = message;
  $('#confirm-action').textContent = label;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {
      once: true,
    }),
  );
}
async function mutate(path, method, message, confirmation) {
  if (busy || dialog.open) return;
  if (confirmation && !(await confirmAction(...confirmation))) return;
  setBusy(true);
  $('#admin-status').textContent = '';
  try {
    await api(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
    await renderLists();
    $('#admin-status').textContent = message;
  } catch (error) {
    $('#admin-status').textContent = error.message;
  } finally {
    setBusy(false);
    if (!document.activeElement || document.activeElement === document.body)
      $('#refresh-admin').focus();
  }
}
function banCreator(fingerprint, label = 'ban creator') {
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
function reportingBan(fingerprint, unban = false) {
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
function revokeToken(hash) {
  return mutate('tokens/' + hash + '/revoke', 'POST', 'token revoked.', [
    'this token will no longer sign in. all its active sessions will be ended.',
    'revoke token',
  ]);
}
function rowActions(actions, label) {
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
          run();
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
    menu.querySelector('button').focus();
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
    index = buttons.indexOf(document.activeElement);
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
function renderRow(kind, item) {
  const row = element('tr'),
    actions = [];
  const cell = (...children) => {
    const td = element('td');
    td.append(...children);
    row.append(td);
  };
  if (kind === 'tokens') {
    cell(element('code', shortHash(item.token_hash)));
    cell(status(item.revoked_at ? 'revoked' : 'active', !!item.revoked_at));
    cell(element('span', item.cards));
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
    cell(element('span', item.identities));
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
      if (item.reporter_fingerprint)
        actions.push(
          ['ban reporter from reporting', () => reportingBan(item.reporter_fingerprint), true],
          [
            'ban reporter entirely',
            () => banCreator(item.reporter_fingerprint, 'ban reporter entirely'),
            true,
          ],
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
    if (!item.removed) {
      if (item.creator_fingerprint)
        actions.push(['ban creator', () => banCreator(item.creator_fingerprint), true]);
      if (item.token_hash)
        actions.push(['revoke creator token', () => revokeToken(item.token_hash), true]);
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
  row.append(rowActions(actions, item.slug || shortHash(item.fingerprint || item.token_hash)));
  return row;
}
async function renderList(kind) {
  let data;
  for (;;) {
    data = await api(
      (kind === 'links' ? 'cards' : kind) +
        '?' +
        new URLSearchParams({ offset: offsets[kind], q: kind === 'links' ? query : '' }),
    );
    if (data.items.length || !offsets[kind]) break;
    offsets[kind] -= 50;
  }
  const list = $('#' + lists[kind]);
  const rows = data.items.map((item) => renderRow(kind, item));
  if (!rows.length) {
    const row = element('tr'),
      td = element('td', empty[kind], 'admin-empty');
    td.colSpan = list.closest('table').querySelectorAll('th').length;
    row.append(td);
    rows.push(row);
  }
  list.replaceChildren(...rows);
  for (const [direction, disabled] of [
    ['previous', offsets[kind] === 0],
    ['next', !data.hasMore],
  ]) {
    const button = $('#' + kind + '-' + direction);
    button.disabled = busy || disabled;
    if (busy) button.dataset.wasDisabled = String(disabled);
  }
  $('#' + kind + '-count').textContent = data.items.length + (data.hasMore ? '+' : '') + ' shown';
  $('#' + kind + '-page').textContent = 'page ' + (offsets[kind] / 50 + 1);
}
async function renderLists() {
  for (const kind of kinds) await renderList(kind);
}
async function refresh() {
  if (busy) return;
  setBusy(true);
  $('#admin-status').textContent = '';
  try {
    await renderLists();
  } catch (error) {
    $('#admin-status').textContent = error.message;
  } finally {
    setBusy(false);
  }
}
function selectTab(tab) {
  document.querySelectorAll('.admin-tabs [role="tab"]').forEach((button) => {
    const selected = tab === button;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    $('#' + button.getAttribute('aria-controls')).hidden = !selected;
  });
  if (menu.matches(':popover-open')) menu.hidePopover();
  history.replaceState(null, '', '#' + tab.id.replace('-tab', ''));
}
document.querySelectorAll('.admin-tabs [role="tab"]').forEach((tab) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    const tabs = [...document.querySelectorAll('.admin-tabs [role="tab"]')],
      index = tabs.indexOf(tab);
    const next =
      event.key === 'ArrowRight'
        ? tabs[(index + 1) % tabs.length]
        : event.key === 'ArrowLeft'
          ? tabs[(index + tabs.length - 1) % tabs.length]
          : event.key === 'Home'
            ? tabs[0]
            : event.key === 'End'
              ? tabs.at(-1)
              : null;
    if (next && !busy) {
      event.preventDefault();
      selectTab(next);
      next.focus();
    }
  });
});
$('#refresh-admin').addEventListener('click', refresh);
$('#admin-search').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!busy) {
    query = $('#admin-query').value.trim();
    offsets.links = 0;
    refresh();
  }
});
for (const kind of kinds)
  for (const [direction, change] of [
    ['previous', -50],
    ['next', 50],
  ]) {
    $('#' + kind + '-' + direction).addEventListener('click', () => {
      if (!busy) {
        offsets[kind] = Math.max(0, offsets[kind] + change);
        refresh();
      }
    });
  }
$('#ban-slug-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  try {
    const slug = normalizeSlug($('#ban-slug-value').value.trim());
    await mutate('slugs/' + slug + '/ban', 'POST', 'slug banned.', [
      '/' + slug + ' will be unavailable until unbanned.',
      'ban slug',
    ]);
  } catch (error) {
    $('#admin-status').textContent = error.message;
  }
});
dialog.setAttribute('closedby', 'any');
if (!('closedBy' in dialog)) {
  let pressedOutside = false;
  const outside = (event) => {
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
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon'));
  $('#theme-toggle').setAttribute(
    'aria-label',
    'switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode',
  );
}
let theme;
try {
  theme = localStorage.getItem('theme');
} catch {}
applyTheme(theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('#theme-toggle').addEventListener('click', () => {
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
selectTab(document.getElementById(location.hash.slice(1) + '-tab') || $('#reports-tab'));
refresh();
