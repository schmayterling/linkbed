// Run in a fresh editor tab. All card API writes are mocked.
(async () => {
  const { MAX_CARDS } = await import('/model.mjs');
  const $ = (selector) => document.querySelector(selector);
  const wait = async (test) => {
    for (let i = 0; i < 100 && !test(); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (!test()) throw new Error('multicard check timed out');
  };
  let passed = 0;
  const check = (value, label) => {
    if (!value) throw new Error(label);
    passed++;
  };
  const input = (selector, value) => {
    $(selector).value = value;
    $(selector).dispatchEvent(new Event('input', { bubbles: true }));
  };
  const editor = (index) => $('#page-card-editors > [data-index="' + index + '"]');
  const count = () => $('#page-card-editors').children.length;
  const active = () => editor(JSON.parse(sessionStorage.getItem('linkbed-editor')).activeCard);
  const select = (index) => {
    if (editor(index).hasAttribute('data-collapsed'))
      editor(index).querySelector('[data-action="toggle"]').click();
  };
  const state = () => JSON.parse(sessionStorage.getItem('linkbed-editor'));
  const close = async (selector) => {
    $(selector).click();
    await wait(() => !document.querySelector('dialog[open]'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const originalFetch = window.fetch;
  const originalTerms = localStorage.getItem('linkbed-terms-accepted');
  const root = (name) => ({
    type: 17,
    accent_color: 0xa2abff,
    components: [{ type: 10, content: '## ' + name }],
  });
  let saved;
  const lastText = '## last\n\n' + 'scrolling content\n\n'.repeat(24);
  const cards = Array.from({ length: 7 }, (_, i) => ({
    slug: 'ordered-' + i,
    title: 'ordered ' + i,
    url: null,
    component: root('ordered ' + i),
  }));
  window.fetch = async (request, options = {}) => {
    const path = new URL(typeof request === 'string' ? request : request.url, location.href)
      .pathname;
    if (!path.startsWith('/api/')) return originalFetch(request, options);
    if (path === '/api/session') return Response.json({ authenticated: true });
    if (path === '/api/cards' && (!options.method || options.method === 'GET'))
      return Response.json(saved ? [saved, ...cards] : cards);
    if (path === '/api/cards' && options.method === 'POST') {
      saved = JSON.parse(options.body);
      return Response.json(saved);
    }
    if (path === '/api/cards/multicard-check' && (!options.method || options.method === 'GET'))
      return Response.json(saved);
    throw new Error('unexpected API call: ' + (options.method || 'GET') + ' ' + path);
  };
  try {
    $('#clear-template').click();
    await wait(() => !$('#title').value);
    input('#title', 'multicard check');
    input('#slug', 'multicard-check');
    $('#add-component').click();
    input('#component-list textarea', '## first');
    $('#no-accent').checked = false;
    $('#no-accent').dispatchEvent(new Event('input', { bubbles: true }));
    input('#color', '#5865f2');
    check($('#page-management-controls').hidden, 'page tools start collapsed for single card');
    $('#enable-page-tools').click();
    check(!$('#page-management-controls').hidden, 'page tools opt-in reveals controls');
    $('#enable-page-tools').click();
    check(
      !$('.seo-settings').hidden && !$('.seo-settings').open,
      'seo stays visible and collapsed without page tools',
    );
    $('#enable-page-tools').click();
    input('#source-url', 'https://example.com/');
    check(!$('#add-page-card').disabled, 'redirect keeps page actions enabled');
    check(
      !$('#page-link-warning').hidden &&
        $('#page-link-warning').textContent.includes('only card shown'),
      'destination warning appears under preview selector',
    );
    $('#add-page-card').click();
    check(
      count() === 2 && $('#source-url').value === 'https://example.com/',
      'adding cards preserves destination',
    );
    input('#component-list textarea', '## second');
    input('#color', '#ff0000');
    check(!$('#source-url').disabled, 'multiple cards leave destination editable');
    input('#source-url', 'https://example.com/');
    check(
      !active().querySelector('[data-action="copy"]').disabled,
      'redirect hides warning and keeps duplication enabled',
    );
    check(state().draft.card.additional_cards.length === 1, 'setting destination preserves cards');
    input('#source-url', '');
    check(
      !document.querySelector('#page-card-choice, #cards-dialog'),
      'picker and manager modal removed',
    );
    check(count() === 2, 'two cards editable');
    check(
      $('#page-preview-cards').children.length === 2 && !$('#page-preview-cards').hidden,
      'page preview renders both cards',
    );
    check(
      $('#preview-card').textContent.includes('first') &&
        !$('#preview-card').textContent.includes('second'),
      'discord preview stays first card',
    );
    check(
      state().draft.card.color === '#5865f2',
      'editing another accent preserves first card metadata',
    );
    check(
      state().draft.card.additional_cards[0].accent_color === 0xff0000,
      'additional card accent persists',
    );
    active().querySelector('[data-action="copy"]').click();
    check(count() === 3, 'card duplication inserts a copy');
    input('#component-list textarea', '## duplicate');
    select(1);
    check($('#component-list textarea').value === '## second', 'duplicate edits stay independent');
    select(2);
    active().querySelector('[data-action="trash-2"]').click();
    await close('#confirm-action');
    await wait(() => count() === 2);
    select(1);
    check(
      editor(0).hasAttribute('data-collapsed') && !editor(1).hasAttribute('data-collapsed'),
      'only active card expanded',
    );
    editor(1).querySelector('[data-action="toggle"]').click();
    check(editor(1).hasAttribute('data-collapsed'), 'active card collapses');
    select(1);
    editor(1).querySelector('[data-action="arrow-up"]').click();
    check(
      state().draft.card.component.components[0].content === '## second',
      'moving card up changes automatic preview card',
    );
    check(state().draft.card.color === '#ff0000', 'moving card updates first accent');
    $('#embed-card-choice').value = '1';
    $('#embed-card-choice').dispatchEvent(new Event('change', { bubbles: true }));
    check(
      state().draft.card.embed_card === 1 && $('#preview-card').textContent.includes('first'),
      'chosen card overrides link preview',
    );
    editor(1).querySelector('[data-action="arrow-up"]').click();
    check(
      state().draft.card.embed_card === 0 && $('#preview-card').textContent.includes('first'),
      'chosen card follows reorder including index zero',
    );
    editor(0)
      .querySelector('.card-handle')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    check(state().draft.card.embed_card === 1, 'keyboard reorder keeps chosen card pinned');
    $('#embed-card-choice').value = 'auto';
    $('#embed-card-choice').dispatchEvent(new Event('change', { bubbles: true }));
    check(
      !('embed_card' in state().draft.card) && $('#preview-card').textContent.includes('second'),
      'automatic preview returns to first card',
    );
    select(1);
    check($('#component-list textarea').value === '## first', 'switching cards preserves content');
    active().querySelector('[data-action="trash-2"]').click();
    check($('#confirm-dialog').open, 'remove asks before discarding');
    await close('#confirm-dialog [value="cancel"]');
    check(count() === 2, 'cancel preserves card');
    active().querySelector('[data-action="trash-2"]').click();
    await close('#confirm-action');
    await wait(() => count() === 1 && !$('#source-url').disabled);
    check(count() === 1 && !$('#source-url').disabled, 'one card enables destination again');
    for (let i = 1; i < MAX_CARDS; i++) {
      $('#add-page-card').click();
      await wait(() => count() === i + 1);
    }
    check(
      count() === MAX_CARDS &&
        $('#add-page-card').disabled &&
        active().querySelector('[data-action="copy"]').disabled,
      '27-card limit',
    );
    $('#add-page-card').click();
    check(count() === MAX_CARDS, 'cap cannot be bypassed by click');
    input('#component-list textarea', 'x'.repeat(3100));
    select(0);
    check(
      $('#validation-list').textContent.includes('card ' + MAX_CARDS),
      'invalid inactive card is identified',
    );
    $('#publish-button').click();
    check(!$('#publish-dialog').open, 'inactive invalid card blocks publishing');
    select(MAX_CARDS - 1);
    input('#component-list textarea', lastText);
    check($('#validation-list').hidden, 'fixed card clears validation');
    check(
      JSON.parse($('#component-json').value).additional_cards.length === MAX_CARDS - 1,
      'json editor keeps every card',
    );
    check(
      $('#seo-preview-title').textContent === 'multicard check',
      'seo title generated from card name',
    );
    check(
      $('#seo-preview-description').textContent.includes('second'),
      'seo description generated from chosen card',
    );
    input('#seo-title', 'temporary title');
    input('#description', 'temporary description');
    $('#reset-seo').click();
    check(
      !$('#seo-title').value &&
        !$('#description').value &&
        $('#seo-preview-description').textContent.includes('second'),
      'reset seo restores generated defaults',
    );
    input('#seo-favicon', 'https://example.com/icon.png');
    check(
      state().draft.card.seo.favicon === 'https://example.com/icon.png' &&
        !$('#seo-preview-icon').hidden,
      'custom favicon previews and persists',
    );
    input('#seo-title', 'social title');
    input('#description', 'social description');
    check(
      $('#seo-preview-title').textContent === 'social title' &&
        $('#seo-preview-description').textContent === 'social description',
      'seo overrides update generated preview',
    );
    input('#page-theme', 'light');
    input('#page-light-background', '#eef3ff');
    input('#page-light-card', '#ffffff');
    input('#page-dark-text', '#eeeeee');
    check(
      state().draft.card.page_theme === 'light' &&
        state().draft.card.page_colors.light.background === '#eef3ff',
      'page appearance persists in draft',
    );
    check(
      $('.discord-window').dataset.previewTheme === 'light' &&
        $('.discord-window').style.getPropertyValue('--preview-page-bg') === '#eef3ff',
      'page preview uses forced light palette',
    );
    $('[data-preview-mode="discord"]').click();
    check(
      !$('.discord-window').style.getPropertyValue('--preview-page-bg'),
      'discord preview ignores page colors',
    );
    $('[data-preview-mode="page"]').click();
    $('#reset-page-appearance').click();
    check(
      !state().draft.card.page_theme && !state().draft.card.page_colors,
      'appearance reset restores automatic defaults',
    );
    input('#page-theme', 'dark');
    input('#page-dark-background', '#1c1930');
    input('#page-dark-links', '#ddaaff');
    input('#page-dark-button', '#221144');
    input('#page-dark-button_text', '#ffccaa');
    input('#page-color-scheme', 'dark');
    check(
      state().draft.card.page_color_scheme === 'dark' &&
        $('.discord-window').style.getPropertyValue('--discord-button') === '#221144' &&
        $('.discord-window').style.getPropertyValue('--discord-button-text') === '#ffccaa',
      'shared palette includes button background and text',
    );
    input('#page-theme', 'auto');
    $('[data-preview-theme="light"]').click();
    check(
      $('.discord-window').dataset.previewTheme === 'light' &&
        $('.discord-window').style.getPropertyValue('--preview-page-bg') === '#1c1930',
      'shared palette applies in light mode',
    );
    input('#page-theme', 'dark');
    localStorage.setItem('linkbed-terms-accepted', 'true');
    $('#publish-button').click();
    check($('#publish-dialog').open, 'valid cards open confirmation');
    $('#confirm-publish').click();
    await wait(() => !$('#publish-result').hidden && !$('#card-form').inert);
    check(
      saved.additional_cards.length === MAX_CARDS - 1 && saved.url === null,
      'publish saves all cards without redirect',
    );
    await close('#publish-result [data-close]');
    $('#show-cards').click();
    await wait(() => $('#saved-list').children.length === 9);
    const boxes = [...$('#saved-list').children].map((el) => el.getBoundingClientRect());
    if (innerWidth > 760) {
      check(
        boxes[0].y === boxes[1].y &&
          boxes[1].y === boxes[2].y &&
          boxes[0].x < boxes[1].x &&
          boxes[1].x < boxes[2].x,
        'saved cards fill first row left to right',
      );
      check(
        boxes[3].x === boxes[0].x && boxes[3].y > boxes[0].y,
        'saved cards continue on next row',
      );
    } else {
      check(
        boxes.every((box) => box.x === boxes[0].x),
        'mobile uses one column',
      );
      check(
        boxes.every((box, i) => i === 0 || box.y > boxes[i - 1].y),
        'mobile follows DOM order',
      );
    }
    $('.saved-preview').click();
    check(count() === MAX_CARDS, 'opening saved page restores all cards');
    select(MAX_CARDS - 1);
    check($('#component-list textarea').value === lastText, 'last saved card restores content');
    check(
      state().activeCard === MAX_CARDS - 1 && state().previewMode === 'page',
      'active card and preview mode persist for refresh',
    );
    const box = () => {
      const header = $('.channel-bar').getBoundingClientRect();
      const themes = $('.preview-themes').getBoundingClientRect();
      return [header.height, themes.x - header.x, themes.y - header.y];
    };
    const pageBox = box();
    $('[data-preview-mode="discord"]').click();
    check(
      box().every((value, i) => Math.abs(value - pageBox[i]) < 1),
      'preview modes keep header geometry',
    );
    $('[data-preview-mode="page"]').click();
    check(
      getComputedStyle($('#page-preview-cards')).paddingLeft === '16px',
      'page preview keeps inner padding',
    );
    if (innerWidth > 760) {
      const preview = $('#page-preview-cards');
      check(
        preview.scrollHeight > preview.clientHeight &&
          getComputedStyle(preview).overflowY === 'auto',
        'long preview has its own scroll area',
      );
      check(
        getComputedStyle(preview.querySelector('.discord-card')).overscrollBehaviorY === 'auto',
        'cards allow wheel events to reach preview scroller',
      );
      const before = $('.channel-bar').getBoundingClientRect().top;
      preview.scrollTop = 200;
      check(
        preview.scrollTop > 0 && $('.channel-bar').getBoundingClientRect().top === before,
        'preview scroll keeps header fixed',
      );
    }
    check(
      saved.seo.title === 'social title' && saved.description === 'social description',
      'seo overrides persist with saved cards',
    );
    check(
      $('#seo-title').value === 'social title' &&
        $('#seo-favicon').value === 'https://example.com/icon.png',
      'reopening page restores seo fields',
    );
    check(
      $('#page-theme').value === 'dark' &&
        $('#page-dark-background').value === '#1c1930' &&
        saved.page_colors.dark.links === '#ddaaff',
      'reopening page restores forced theme and both palettes',
    );
    $('#show-embed').click();
    check(!$('#embed-target'), 'embed modal stays discord only');
    check(!$('#embed-code').value.includes('## last'), 'discord embed excludes extra cards');
    await close('#embed-dialog [data-close]');
    check(document.documentElement.scrollWidth <= innerWidth, 'no horizontal overflow');
    return { passed, savedCards: saved.additional_cards.length + 1 };
  } finally {
    window.fetch = originalFetch;
    if (originalTerms === null) localStorage.removeItem('linkbed-terms-accepted');
    else localStorage.setItem('linkbed-terms-accepted', originalTerms);
  }
})();
