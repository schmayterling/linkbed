// Run in a fresh editor tab. Changes stay in the browser draft; no API writes.
(async () => {
  const $ = (selector) => document.querySelector(selector);
  const check = (value, label) => {
    if (!value) throw new Error(label);
    passed++;
  };
  const input = (node, value, type = 'input') => {
    if (typeof value === 'boolean') node.checked = value;
    else node.value = value;
    node.dispatchEvent(new Event(type, { bubbles: true }));
    if (typeof value === 'boolean' && type !== 'change')
      node.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const state = () => JSON.parse(sessionStorage.getItem('linkbed-editor'));
  const roots = () => {
    const card = state().draft.card;
    return [card.component, ...(card.additional_cards || [])];
  };
  const field = (name) => {
    const label = [...$('#component-list').querySelectorAll('.composer-field > label')].find(
      (label) => label.textContent === name,
    );
    return document.getElementById(label.htmlFor);
  };
  let passed = 0;
  input($('#enable-page-tools'), true, 'change');
  $('#add-badge-case').click();
  check(!$('#page-card-fields .color-field').hidden, 'badge card shows shared appearance');
  input(field('title'), 'my collection');
  input(field('description'), '**handmade** badges\n\n[visit](https://example.com)');
  input(field('image url'), 'https://example.com/badge.gif');
  input(field('alt text'), 'handmade badge');
  input(field('link (optional)'), 'mailto:hey@ryanaque.com');
  input($('#no-accent'), false);
  input($('#color'), '#6543ab');
  input($('#card-spoiler'), true);
  const badge = () => roots()[state().activeCard];
  check(badge().title === 'my collection', 'title saved');
  check(badge().description.includes('**handmade**'), 'markdown description saved');
  check(badge().accent_color === 0x6543ab && badge().spoiler, 'shared appearance saved');
  let preview = $('#page-preview-cards').children[state().activeCard];
  check(preview.style.getPropertyValue('--card-accent') === '#6543ab', 'accent rendered');
  check(preview.querySelector('strong')?.textContent === 'handmade', 'markdown rendered');
  check(preview.classList.contains('container-spoiler'), 'spoiler rendered');
  check(
    [...preview.children]
      .filter((node) => !node.matches('.reveal-container'))
      .every((node) => node.inert),
    'hidden content cannot receive focus',
  );
  preview.querySelector('.reveal-container').click();
  check(
    preview.classList.contains('revealed') && !preview.querySelector('.reveal-container'),
    'spoiler reveal works',
  );
  check(
    [...preview.children].every((node) => !node.inert),
    'reveal restores interaction',
  );
  const emailLink = preview.querySelector('.badge-collection a');
  check(
    emailLink?.href === 'mailto:hey@ryanaque.com' && !emailLink.target,
    'email badge opens the mail client',
  );
  const image = preview.querySelector('img');
  check(
    image.width === 88 && image.height === 31 && image.alt === 'handmade badge',
    'badge keeps dimensions and alt text',
  );
  const probe = preview.cloneNode(true);
  probe.style.cssText = 'position:fixed;left:-1000px;width:120px;visibility:hidden';
  document.body.append(probe);
  try {
    const sample = probe.querySelector('img');
    sample.width = 500;
    sample.height = 400;
    const size = sample.getBoundingClientRect();
    check(
      size.width === 88 && size.height === 31 && getComputedStyle(sample).objectFit === 'fill',
      'different source dimensions resize strictly to 88 by 31',
    );
  } finally {
    probe.remove();
  }
  input($('#no-accent'), true);
  check(
    badge().accent_color === null &&
      $('#page-preview-cards').children[state().activeCard].classList.contains('no-accent'),
    'none clears accent',
  );
  input($('#no-accent'), false);
  while (state().activeCard > 0)
    $(
      '#page-card-editors > [data-index="' + state().activeCard + '"] [data-action="arrow-up"]',
    ).click();
  check(roots()[0].type === 'badge_case', 'badge card can move before preview card');
  check(
    ![...$('#embed-card-choice').options].some((option) => option.value === '0'),
    'badge card cannot be selected as link preview',
  );
  check(
    !$('#embed-code').value.includes('badge_case') &&
      !$('#embed-code').value.includes('my collection'),
    'Discord export excludes badge card',
  );
  $('#page-card-editors > [data-index="1"] [data-action="toggle"]').click();
  $('#page-card-editors > [data-index="0"] [data-action="toggle"]').click();
  check(
    $('#card-spoiler').checked && !$('#no-accent').checked && $('#color').value === '#6543ab',
    'switching cards preserves appearance controls',
  );
  check(field('description').value === badge().description, 'switching restores description');
  check(document.documentElement.scrollWidth <= innerWidth, 'no horizontal overflow');
  return { passed, badge: badge() };
})();
