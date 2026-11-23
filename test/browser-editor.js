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
  let failWrite = false;
  let signedIn = true;
  let signups = 0;
  let writes = 0;
  let copied = null;
  const clipboard = navigator.clipboard;
  const originalWriteText = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
  Object.defineProperty(clipboard, 'writeText', {
    configurable: true,
    value: async (text) => {
      copied = text;
    },
  });
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
  const longUrl = new URL('https://example.com/' + 'é'.repeat(85)).href;
  const legacy = {
    slug: 'legacy-editor-check',
    title: 'legacy card',
    description: '',
    url: null,
    color: '#5865f2',
    buttons: [{ label: 'open', url: longUrl }],
    images: [],
  };
  window.fetch = async (request, options = {}) => {
    const path = new URL(typeof request === 'string' ? request : request.url, location.href)
      .pathname;
    if (!path.startsWith('/api/')) return originalFetch(request, options);
    const method = options.method || 'GET';
    if (path === '/api/session')
      return Response.json({ authenticated: signedIn, guest: !signedIn });
    if (path === '/api/signup' && method === 'POST') {
      signups++;
      signedIn = true;
      return Response.json({ token: 'test-access-token' });
    }
    if (path === '/api/cards' && method === 'GET') return Response.json([card, legacy]);
    if (path === '/api/import' && method === 'POST')
      return Response.json({
        title: 'import with a long url',
        description: 'imported metadata',
        url: longUrl,
        color: '#5865f2',
        buttons: [{ label: 'visit website', url: longUrl }],
        images: [],
      });
    if (path === '/api/cards' && method === 'POST') {
      writes++;
      card = JSON.parse(options.body);
      return Response.json(card);
    }
    if (path === '/api/cards/editor-check' && method === 'GET')
      return failRead
        ? Response.json({ error: 'saved card unavailable' }, { status: 503 })
        : Response.json(card);
    if (path === '/api/cards/editor-check' && method === 'PUT') {
      if (failWrite) return Response.json({ error: 'save failed' }, { status: 503 });
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
    await wait(
      () =>
        $('.saved-url')?.href === location.origin + '/editor-check' ||
        $('#account-error').textContent,
    );
    check(
      $('.saved-url')?.href === location.origin + '/editor-check' &&
        !!document.querySelector('a.saved-url[href$="/legacy-editor-check"]'),
      'saved list includes cards published under older url limits',
    );
    const publicUrl = $('.saved-url').href;
    $('.saved-copy').click();
    await wait(() => copied === publicUrl);
    check(document.body.dataset.view === 'cards', 'copying saved link does not open the editor');
    $('.saved-preview').click();
    input('#title', 'unsaved');
    input('#slug', 'renamed');
    copied = null;
    $('#copy-card-link').click();
    await wait(() => copied === publicUrl);
    check(!$('#copy-card-link').hidden, 'notice copies published slug before an unsaved rename');
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
    check(!$('#publish-update-notice').hidden, 'edit confirmation shows Discord update notice');
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
    await wait(() => !$('#publish-result').hidden && !$('#card-form').inert);
    check(
      $('#publish-dialog').open && $('#publish-form').hidden,
      'publish stays open at the copy prompt',
    );
    check($('#publish-token-prompt').hidden, 'signed-in publishers do not see token prompt');
    check(!$('#publish-update-notice').hidden, 'successful edit keeps Discord update notice');
    copied = null;
    $('#copy-published-link').click();
    await wait(() => copied === publicUrl && $('#copy-published-label').textContent === 'copied!');
    check(document.activeElement === $('#copy-published-link'), 'success focuses copy action');
    $('#publish-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    check(writes === 1, 'completed publish cannot submit again');
    $('#publish-result [data-close]').click();
    await wait(() => !$('#publish-dialog').open);
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await wait(() => !$('#publish-result').hidden && !$('#card-form').inert);
    check(writes === 2 && $('#publish-dialog').open, 'repeat publish keeps its copy prompt');
    $('#publish-result [data-close]').click();
    await wait(() => !$('#publish-dialog').open);
    await new Promise((resolve) => setTimeout(resolve, 20));
    failWrite = true;
    $('#publish-button').click();
    $('#confirm-publish').click();
    await wait(() => $('#publish-error').textContent === 'save failed' && !$('#card-form').inert);
    check(
      !$('#publish-form').hidden && $('#publish-result').hidden,
      'failed publish keeps retry controls',
    );
    $('#publish-dialog [data-close]').click();
    await wait(() => !$('#publish-dialog').open);

    failWrite = false;
    signedIn = false;
    $('#publish-button').click();
    $('#confirm-publish').click();
    await wait(() => !$('#publish-result').hidden && !$('#card-form').inert);
    check(!$('#publish-token-prompt').hidden, 'guest publishers see token prompt');
    check(!$('#publish-update-notice').hidden, 'guest edits also show Discord update notice');
    check(signups === 0, 'publishing never creates an access token automatically');
    $('#publish-token-prompt .create-token').click();
    await wait(() => $('#account-new-token').open && !$('#card-form').inert);
    check(
      signups === 1 && !$('#publish-dialog').open,
      'token action uses signup and closes publish',
    );
    check($('#publish-token-prompt').hidden, 'creating a token clears guest prompt');
    $('#finish-account').click();
    await wait(() => !$('#account-new-token').open && !$('#new-token').textContent);
    check(!$('#new-token').textContent, 'closing token dialog clears the displayed token');

    $('#make-card').click();
    await wait(() => $('#clear-template').textContent === 'clear template');
    $('#publish-button').click();
    check($('#publish-update-notice').hidden, 'new card confirmation hides Discord update notice');
    $('#confirm-publish').click();
    await wait(() => !$('#publish-result').hidden && !$('#card-form').inert);
    check($('#publish-update-notice').hidden, 'new card success hides Discord update notice');
    $('#publish-result [data-close]').click();
    await wait(() => !$('#publish-dialog').open);

    $('#show-url-import').click();
    input('#url-import-value', longUrl);
    $('#import-button').click();
    await wait(() => !$('#card-form').inert);
    check(
      !$('#url-import-dialog').open &&
        $('#source-url').value === longUrl &&
        $('#component-json').value.includes(longUrl),
      'long imported url opens as an editable draft',
    );
    return { passed };
  } finally {
    window.fetch = originalFetch;
    if (originalWriteText) Object.defineProperty(clipboard, 'writeText', originalWriteText);
    else delete clipboard.writeText;
    if (originalAcceptance === null) localStorage.removeItem('linkbed-terms-accepted');
    else localStorage.setItem('linkbed-terms-accepted', originalAcceptance);
  }
})();
