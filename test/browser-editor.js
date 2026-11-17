// Paste into the console in a fresh editor tab. Card requests are mocked; no database writes.
(async () => {
  const $ = (selector) => document.querySelector(selector);
  const wait = async (test) => {
    for (let i = 0; i < 100; i++) {
      if (test()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('editor check timed out');
  };
  let passed = 0;
  const check = (value, name) => {
    if (!value) throw new Error(name);
    passed++;
  };
  const input = (selector, value) => {
    $(selector).value = value;
    $(selector).dispatchEvent(new Event('input', { bubbles: true }));
  };
  const state = () => JSON.parse(sessionStorage.getItem('linkbed-editor'));
  const confirmDiscard = async (button, done) => {
    $(button).click();
    check($('#confirm-dialog').open, 'dirty draft asks before clearing');
    $('#confirm-action').click();
    await wait(() => done() && !$('#card-form').inert && !$('#confirm-dialog').open);
  };

  if (document.querySelector('dialog[open]') || state()?.draft)
    throw new Error('start in a fresh editor tab');
  const originalFetch = window.fetch;
  const originalAcceptance = localStorage.getItem('linkbed-terms-accepted');
  let failRead = false;
  let writes = 0;
  let card = {
    slug: 'editor-check',
    title: 'saved card',
    url: null,
    description: 'saved description',
    component: {
      type: 17,
      accent_color: 0xa2abff,
      components: [{ type: 10, content: 'saved content' }],
    },
  };
  window.fetch = async (request, options = {}) => {
    const path = new URL(typeof request === 'string' ? request : request.url, location.href)
      .pathname;
    if (!path.startsWith('/api/')) return originalFetch(request, options);
    const method = options.method || 'GET';
    if (path === '/api/session') return Response.json({ authenticated: true });
    if (path === '/api/cards' && method === 'GET') return Response.json([card]);
    if (path === '/api/cards/editor-check' && method === 'GET')
      return failRead
        ? Response.json({ error: 'saved card unavailable' }, { status: 503 })
        : Response.json(card);
    if (path === '/api/cards/editor-check' && method === 'PUT') {
      writes++;
      card = { ...JSON.parse(options.body), slug: 'editor-check' };
      return Response.json(card);
    }
    throw new Error('unexpected mocked request: ' + method + ' ' + path);
  };

  try {
    localStorage.removeItem('linkbed-terms-accepted');
    check(!$('#editor-notice').hidden, 'starter shows clear action');
    $('#clear-template').click();
    check(
      !$('#title').value &&
        !$('#source-url').value &&
        !$('#slug').value &&
        JSON.parse($('#component-json').value).component.components.length === 0,
      'clear template empties the form',
    );
    check($('#editor-errors').hidden && !state().draft.dirty, 'clear keeps fresh errors hidden');
    check(
      state().draft.card.component.components.length === 0,
      'empty state is stored for refresh',
    );
    input('#title', 'unfinished');
    await confirmDiscard('#reset', () => !$('#title').value);
    check(!$('#title').value, 'bottom clear uses the same empty reset');

    $('#show-cards').click();
    await wait(() => $('.saved-preview'));
    $('.saved-preview').click();
    input('#title', 'unsaved');
    input('#slug', 'renamed');
    input('#component-list textarea', 'unsaved content');
    $('#clear-template').click();
    $('#confirm-dialog [value="cancel"]').click();
    await wait(() => !$('#confirm-dialog').open);
    await new Promise((resolve) => setTimeout(resolve, 20));
    check($('#title').value === 'unsaved', 'cancel preserves edits');
    await confirmDiscard('#clear-template', () => $('#title').value === 'saved card');
    check(
      $('#title').value === 'saved card' &&
        $('#slug').value === 'editor-check' &&
        $('#component-list textarea').value === 'saved content',
      'clear restores saved fields, slug, and content',
    );
    input('#title', 'keep me');
    failRead = true;
    await confirmDiscard(
      '#reset',
      () => $('#form-status').textContent === 'saved card unavailable',
    );
    check($('#title').value === 'keep me' && state().draft.dirty, 'failed read preserves draft');
    failRead = false;
    await confirmDiscard('#reset', () => $('#title').value === 'saved card');
    check(writes === 0, 'clearing never writes to the database');

    $('#publish-button').click();
    check(
      $('#publish-dialog').open &&
        !$('#publish-confirm').closest('label').hidden &&
        $('#confirm-publish').disabled,
      'first publish requires agreement',
    );
    $('#publish-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    check(writes === 0, 'unchecked agreement blocks publishing');
    $('#publish-confirm').click();
    $('#publish-dialog [data-close]').click();
    await wait(() => !$('#publish-dialog').open);
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(!localStorage.getItem('linkbed-terms-accepted'), 'cancel does not record agreement');
    $('#publish-button').click();
    $('#publish-confirm').click();
    $('#confirm-publish').click();
    await wait(() => !$('#publish-dialog').open);
    check(
      writes === 1 && localStorage.getItem('linkbed-terms-accepted') === 'true',
      'publish remembers agreement',
    );
    $('#publish-button').click();
    check(
      $('#publish-dialog').open &&
        $('#publish-confirm').closest('label').hidden &&
        !$('#publish-confirm').required &&
        !$('#confirm-publish').disabled,
      'repeat publish keeps confirmation without checkbox',
    );
    $('#confirm-publish').click();
    await wait(() => !$('#publish-dialog').open);
    check(writes === 2, 'repeat publish works');
    return { passed };
  } finally {
    window.fetch = originalFetch;
    if (originalAcceptance === null) localStorage.removeItem('linkbed-terms-accepted');
    else localStorage.setItem('linkbed-terms-accepted', originalAcceptance);
  }
})();
