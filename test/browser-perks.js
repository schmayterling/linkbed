// Run in a fresh editor tab. Every API request is mocked; no database writes.
(async () => {
  const $ = (selector) => document.querySelector(selector);
  const wait = async (condition) => {
    for (let i = 0; i < 100 && !condition(); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (!condition()) throw new Error('perks check timed out');
  };
  let passed = 0,
    writes = 0;
  const check = (value, label) => {
    if (!value) throw new Error(label);
    passed++;
  };
  const card = (slug, badges = [], sponsored = false) => ({
    slug,
    title: slug,
    url: null,
    description: '',
    component: { type: 17, components: [{ type: 10, content: '## ' + slug }] },
    badges,
    sponsored,
  });
  const cards = [
    card(
      'mayv',
      [
        { name: 'verified', icon: 'badge-check' },
        { name: 'sponsor', icon: 'heart' },
        {
          name: 'funky',
          image: 'https://i.pinimg.com/originals/d8/04/2d/d8042d88f4fee3f133e56a3a5cfde0e3.gif',
        },
      ],
      true,
    ),
    card('untagged'),
    card('long-tag', [
      { name: '<img src=x onerror=alert(1)>', image: 'https://example.com/badge.gif' },
      { name: 'long '.repeat(16), image: 'https://example.com/badge.gif' },
    ]),
  ];
  const originalFetch = window.fetch;
  window.fetch = async (request, options = {}) => {
    const path = new URL(typeof request === 'string' ? request : request.url, location.href)
      .pathname;
    if (!path.startsWith('/api/')) return originalFetch(request, options);
    if (path === '/api/session') return Response.json({ authenticated: true });
    if (path === '/api/cards') return Response.json(cards);
    if (path === '/api/cards/mayv' && options.method === 'PUT') {
      const body = JSON.parse(options.body);
      check(body.sponsor_hidden === true && !('sponsored' in body), 'save only changes visibility');
      Object.assign(cards[0], body);
      writes++;
      return Response.json({ slug: 'mayv', revision: 2 });
    }
    return Response.json({ error: 'unmocked request' }, { status: 400 });
  };
  const tile = (slug) =>
    [...$('#saved-list').children].find(
      (node) => node.querySelector('.saved-url')?.pathname === '/' + slug,
    );
  const open = async (slug) => {
    $('#saved-list').replaceChildren();
    $('#show-cards').click();
    await wait(() => tile(slug));
    tile(slug).querySelector('.saved-preview').click();
    await wait(() => document.body.dataset.view === 'editor');
  };
  try {
    $('#saved-list').replaceChildren();
    $('#show-cards').click();
    await wait(() => tile('mayv')?.querySelector('.saved-badge'));
    check(
      [...tile('mayv').querySelectorAll('.saved-badge')]
        .map((node) => node.getAttribute('aria-label'))
        .join(',') === 'verified,sponsor,funky',
      'saved card shows ordered tags',
    );
    check(!tile('untagged').querySelector('.saved-badge'), 'untagged card has no empty tag row');
    check(
      tile('long-tag')
        .querySelector('.saved-badge')
        .getAttribute('aria-label')
        .startsWith('<img') && tile('long-tag').querySelectorAll('.saved-badge img').length === 2,
      'badge names remain accessible without injecting markup',
    );
    check(
      tile('mayv').querySelector('.saved-url-label').textContent === '/mayv',
      'displayed link omits domain',
    );
    check(
      tile('mayv').querySelector('.saved-url').href === location.origin + '/mayv',
      'link still opens full URL',
    );
    check(
      tile('mayv').querySelectorAll('.saved-badge .icon').length === 2,
      'verified and sponsor use actual icons',
    );
    check(
      tile('mayv').querySelector('.saved-badge img').src.includes('i.pinimg.com'),
      'custom badge uses its image',
    );
    check(
      [...tile('mayv').querySelectorAll('.saved-badge')].every((badge) =>
        badge.parentElement.classList.contains('saved-link'),
      ),
      'badges sit beside URL',
    );
    check(
      [...tile('mayv').querySelectorAll('.saved-badge')].every(
        (badge) =>
          !badge.textContent.trim() &&
          getComputedStyle(badge).borderRadius === '0px' &&
          getComputedStyle(badge).borderTopWidth === '0px',
      ),
      'badges contain only icons with no pill styling',
    );
    const copyRect = tile('mayv').querySelector('.saved-copy').getBoundingClientRect();
    const deleteRect = tile('mayv').querySelector('.saved-delete').getBoundingClientRect();
    check(
      copyRect.y === deleteRect.y &&
        copyRect.height === deleteRect.height &&
        copyRect.width === deleteRect.width,
      'copy and delete share an aligned button box',
    );
    check(document.documentElement.scrollWidth <= innerWidth, 'saved tags fit viewport');
    await open('mayv');
    check(!$('#perk-management').hidden, 'donor sees perk management');
    check(
      $('#perk-management').nextElementSibling.classList.contains('seo-settings'),
      'perks sits above link metadata',
    );
    $('#perk-management').open = true;
    check($('#show-sponsor').checked, 'sponsor badge shown by default');
    $('#show-sponsor').click();
    check(
      JSON.parse(sessionStorage.getItem('linkbed-editor')).draft.card.sponsor_hidden,
      'hide switch updates draft',
    );
    $('#publish-button').click();
    await wait(() => $('#publish-dialog').open);
    if (!$('#publish-confirm').closest('label').hidden) $('#publish-confirm').click();
    $('#confirm-publish').click();
    await wait(() => writes === 1 && $('#publish-form').hidden);
    $('#publish-result [data-close]').click();
    await wait(() => !$('#publish-dialog').open);
    await open('mayv');
    check(!$('#show-sponsor').checked, 'hidden preference survives save and reopen');
    await open('untagged');
    check($('#perk-management').hidden, 'non-donor has no perk section');
    await open('mayv');
    check(!$('#show-sponsor').checked, 'other cards do not overwrite donor preference');
    $('#saved-list').replaceChildren();
    $('#show-cards').click();
    await wait(() => tile('mayv')?.querySelector('.saved-badge'));
    check(
      tile('mayv').querySelector('[aria-label="sponsor"]') !== null,
      'hidden sponsor remains tagged in owner list',
    );
    return { passed, writes, width: innerWidth };
  } finally {
    window.fetch = originalFetch;
  }
})();
