// Paste in the browser console, reload the page, then paste again. No account or card writes.
(() => {
  const key = 'linkbed-editor',
    testKey = 'linkbed-reload-test';
  const $ = (selector) => document.querySelector(selector);
  const previous = sessionStorage.getItem(testKey);
  if (previous === null) {
    if (document.querySelector('dialog[open]')) throw new Error('close dialogs before testing');
    sessionStorage.setItem(testKey, JSON.stringify({ original: sessionStorage.getItem(key) }));
    const input = (selector, value) => {
      const field = $(selector);
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    input('#title', 'unfinished card');
    input('#source-url', 'not a url yet');
    input('#slug', 'unfinished-card');
    input('#component-list textarea', 'still writing');
    input('#component-json', '{unfinished');
    $('#preview-tab').click();
    $('#show-cards').click();
    return 'reload, then run this check again';
  }
  let passed = 0;
  const check = (value, name) => {
    if (!value) throw new Error(name);
    passed++;
  };
  try {
    check(document.body.dataset.view === 'cards', 'saved cards view survives refresh');
    check(
      $('#preview-tab').getAttribute('aria-selected') === 'true',
      'mobile tab survives refresh',
    );
    check($('#title').value === 'unfinished card', 'title survives refresh');
    check($('#source-url').value === 'not a url yet', 'incomplete field survives refresh');
    check($('#slug').value === 'unfinished-card', 'slug survives refresh');
    check($('#component-list textarea').value === 'still writing', 'component survives refresh');
    check($('#component-json').value === '{unfinished', 'unapplied json survives refresh');
    check($('#publish-button').disabled, 'unapplied json still blocks publish');
    check(
      Object.keys(JSON.parse(sessionStorage.getItem(key)))
        .sort()
        .join() ===
        'activeCard,draft,embedMode,expandedCard,pageTools,previewMode,scroll,showErrors,tab,view',
      'storage contains only editor state',
    );
    return { passed };
  } finally {
    const { original } = JSON.parse(previous);
    if (original === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, original);
    sessionStorage.removeItem(testKey);
  }
})();
