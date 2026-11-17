// Run on a standalone card page. Report requests are mocked.
(async () => {
  const $ = (selector) => document.querySelector(selector);
  let passed = 0,
    sends = 0,
    fail = true,
    release;
  const check = (value, label) => {
    if (!value) throw new Error(label);
    passed++;
  };
  const wait = async (test) => {
    for (let i = 0; i < 100; i++) {
      if (test()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('public check timed out');
  };
  const originalFetch = window.fetch;
  const url = location.href;
  window.fetch = async (request, options) => {
    if (request !== '/api/reports') return originalFetch(request, options);
    sends++;
    const body = JSON.parse(options.body);
    check(
      body.url === $('#report-url').value &&
        body.confirmed === true &&
        body.reason === 'other' &&
        body.details === 'test reason',
      'report sends current card and consent',
    );
    await new Promise((resolve) => {
      release = resolve;
    });
    return fail
      ? Response.json({ error: 'try again' }, { status: 503 })
      : Response.json({ reported: true });
  };
  try {
    $('#report-abuse').click();
    check($('#report-dialog').open && location.href === url, 'report opens without navigating');
    const appearance = JSON.parse($('#page-appearance')?.textContent || '{}');
    const scheme = appearance.colorScheme || document.documentElement.dataset.theme;
    const palette = appearance.colors?.[scheme] || {};
    check(
      getComputedStyle($('#report-dialog')).colorScheme === scheme,
      'report uses page color scheme',
    );
    if (palette.card) {
      const background = getComputedStyle($('#public-card')).backgroundColor;
      for (const selector of [
        '#report-dialog',
        '#report-dialog .card-titlebar',
        '#report-url',
        '#report-reason',
      ])
        check(
          getComputedStyle($(selector)).backgroundColor === background,
          selector + ' uses page surface',
        );
    }
    if (palette.button && $('.preview-button')) {
      const button = getComputedStyle($('.preview-button'));
      const submit = getComputedStyle($('#send-report'));
      check(submit.backgroundColor === button.backgroundColor, 'report uses page button color');
      check(submit.color === button.color, 'report uses page button text color');
    }
    check(
      !$('#report-confirm').checked && $('#report-url').readOnly,
      'report starts unchecked with fixed card',
    );
    $('#send-report').click();
    check(sends === 0, 'unchecked report does not send');
    $('#report-confirm').checked = true;
    $('#send-report').click();
    check(sends === 0, 'reason is required');
    $('#report-reason').value = 'other';
    $('#report-reason').dispatchEvent(new Event('change', { bubbles: true }));
    check(
      !$('#report-details-field').hidden && $('#report-details').required,
      'other reveals required explanation',
    );
    $('#send-report').click();
    check(sends === 0, 'other explanation required');
    $('#report-details').value = 'test reason';
    $('#send-report').click();
    await wait(() => sends === 1);
    check($('#send-report').disabled, 'sending prevents duplicate reports');
    release();
    await wait(() => !$('#send-report').disabled);
    check(
      $('#report-error').textContent === 'try again' && $('#report-dialog').open,
      'report failure stays retryable',
    );
    fail = false;
    $('#send-report').click();
    await wait(() => sends === 2);
    release();
    await wait(() => !$('#report-success').hidden);
    check($('#report-form').hidden && location.href === url, 'success stays on same page');
    $('#report-dialog [data-close]').click();
    check(!$('#report-dialog').open, 'success closes');
    $('#report-abuse').click();
    check(
      !$('#report-form').hidden &&
        !$('#report-confirm').checked &&
        $('#report-success').hidden &&
        !$('#report-reason').value &&
        $('#report-details-field').hidden,
      'reopen resets report',
    );
    $('#report-dialog [data-close]').click();
    check(
      getComputedStyle($('#report-abuse')).color === getComputedStyle($('.public-footer a')).color,
      'report uses link tint',
    );
    return { passed };
  } finally {
    window.fetch = originalFetch;
  }
})();
