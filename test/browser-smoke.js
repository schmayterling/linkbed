// Paste into the console at http://localhost:3000; no account or database changes.
(async () => {
  const { renderComponent, textPreview, createComposer, collapseDragZone } =
    await import('/components.mjs');
  const check = (value, name) => {
    if (!value) throw new Error(name);
  };
  const text = textPreview(
    '# heading\n**bold** __underline__ ~~strike~~ ||**hidden**||\n\n-# footer\n\n<t:1700000000> <t:1700000000:S> <t:bad> <a:bad> <script>alert(1)</script> [bad](javascript:alert(1))',
  );
  check(
    text.querySelector('h1') &&
      text.querySelector('strong') &&
      text.querySelector('u') &&
      text.querySelector('s'),
    'markdown',
  );
  check(text.querySelectorAll('time').length === 2, 'timestamps');
  check(
    !text.querySelector('.discord-subtext') && text.textContent.includes('-# footer'),
    'subtext stays literal like Discord component embeds',
  );
  check(
    textPreview('body\n-# **footer**').querySelector('strong')?.textContent === 'footer',
    'literal subtext retains inline formatting',
  );
  check(!text.querySelector('script, a[href^="javascript:"]'), 'safe html');
  text.querySelector('.text-spoiler').click();
  check(text.querySelector('.text-spoiler.revealed'), 'text spoiler');

  const root = {
    type: 17,
    accent_color: 0xff00ff,
    spoiler: true,
    components: [
      { type: 10, content: 'hello' },
      {
        type: 9,
        components: [{ type: 10, content: 'section' }],
        accessory: { type: 11, media: { url: 'https://example.com/image.png' }, spoiler: true },
      },
      { type: 12, items: [{ media: { url: 'https://example.com/video.mp4' }, spoiler: true }] },
      { type: 14, divider: false, spacing: 2 },
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: 'go',
            url: 'https://example.com',
            disabled: true,
            emoji: { name: '🔥', id: null },
          },
        ],
      },
    ],
  };
  const preview = document.createElement('article');
  renderComponent(preview, root);
  check(preview.querySelector('video').controls, 'video controls');
  check(preview.querySelector('.component-thumbnail'), 'thumbnail');
  check(preview.querySelector('.component-separator.no-divider.large'), 'separator');
  check(preview.querySelector('button.preview-button:disabled'), 'disabled button');
  check(preview.querySelector('.component-text').inert, 'container spoiler focus');
  preview.classList.add('discord-card');
  preview.style.cssText = 'position:fixed;left:-10000px;width:320px;visibility:hidden';
  document.body.append(preview);
  check(
    getComputedStyle(preview.querySelector('.reveal-container')).marginTop === '0px',
    'reveal covers entire card',
  );
  preview.remove();
  preview.querySelector('.reveal-container').click();
  check(!preview.querySelector('.component-text').inert, 'container reveal');
  const media = preview.querySelector('.component-media');
  check(media.querySelector('video').inert, 'media spoiler focus');
  media.querySelector('.reveal-media').click();
  check(!media.querySelector('video').inert, 'media reveal');

  const fields = document.createElement('div');
  fields.style.cssText = 'position:fixed;left:-10000px;width:320px;visibility:hidden';
  document.body.append(fields);
  let updates = 0;
  const composer = createComposer(fields, () => updates++);
  composer.set(root);
  check(
    composer.get().components.length === 5 &&
      fields.querySelectorAll('.component-editor').length === 5,
    'composer roundtrip',
  );
  const input = fields.querySelector('textarea');
  input.value = 'changed';
  input.dispatchEvent(new Event('input'));
  check(composer.get().components[0].content === 'changed', 'composer edits');
  composer.add(14);
  check(composer.get().components.length === 6 && updates === 3, 'composer add');
  composer.set({
    type: 17,
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: 'first', url: 'https://example.com/a' },
          { type: 2, style: 5, label: 'second', url: 'https://example.com/b', disabled: true },
        ],
      },
      {
        type: 12,
        items: [
          { media: { url: 'https://example.com/1.png' }, spoiler: true },
          { media: { url: 'https://example.com/2.png' } },
        ],
      },
    ],
  });
  check(
    fields.querySelector('[aria-label="move button up"]').disabled,
    'first item cannot move up',
  );
  fields.querySelector('[aria-label="move button down"]').click();
  check(
    composer
      .get()
      .components[0].components.map((node) => node.label)
      .join() === 'second,first',
    'reorder buttons',
  );
  check(composer.get().components[0].components[0].disabled, 'reorder preserves button state');
  fields.querySelectorAll('[aria-label="duplicate button"]')[0].click();
  check(
    composer.get().components[0].components.length === 3 &&
      composer.get().components[0].components[1].disabled,
    'duplicate preserves button state',
  );
  fields
    .querySelectorAll('.component-editor')[0]
    .querySelectorAll('.item-footer .text-button')[1]
    .click();
  fields.querySelectorAll('[aria-label="duplicate media"]')[0].click();
  check(
    composer.get().components[1].items.length === 3 &&
      composer.get().components[1].items[1].spoiler,
    'duplicate preserves media state',
  );
  fields
    .querySelectorAll('.component-editor')[1]
    .querySelectorAll('.item-footer .text-button')[1]
    .click();
  fields.querySelectorAll('[aria-label="move media up"]')[1].click();
  check(composer.get().components[1].items[1].spoiler, 'reorder preserves media state');
  fields.querySelector('.item-footer .text-button').click();
  check(composer.get().components[0].components.length === 1, 'remove reordered item');
  fields
    .querySelectorAll('.component-editor')[1]
    .querySelector('.item-handle')
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
  check(composer.get().components[1].items[0].spoiler, 'keyboard handle reorder');
  fields
    .querySelector('.block-handle')
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
  check(composer.get().components[0].type === 12, 'keyboard block reorder');
  check(
    fields.querySelectorAll('[role="switch"]').length === 3,
    'editor checkboxes use accessible switches',
  );
  const switchInput = fields.querySelector('[role="switch"]');
  const before = switchInput.checked;
  switchInput.click();
  check(
    switchInput.checked !== before && !!composer.get().components[0].items[0].spoiler === !before,
    'switch changes model',
  );
  check(fields.querySelectorAll('.emoji-choose').length === 1, 'button offers emoji picker');
  check(
    fields.querySelector('.item-footer .button.danger.secondary'),
    'remove item uses destructive button',
  );
  composer.add(10);
  const markdownInput = fields.querySelector('textarea');
  markdownInput.value = 'hello';
  markdownInput.dispatchEvent(new Event('input'));
  markdownInput.setSelectionRange(0, 5);
  const toolbar = markdownInput.previousElementSibling;
  toolbar.querySelector('[aria-label="bold"]').click();
  check(markdownInput.value === '**hello**', 'bold toolbar preserves selection');
  toolbar.querySelector('[aria-label="bold"]').click();
  check(markdownInput.value === 'hello', 'bold toolbar toggles formatting');
  markdownInput.setSelectionRange(0, 5);
  toolbar.querySelector('[aria-label="spoiler"]').click();
  check(
    textPreview(markdownInput.value).querySelector('.text-spoiler'),
    'toolbar inserts Discord spoiler',
  );
  const blockFormat = toolbar.querySelector('select');
  check(
    !blockFormat.querySelector('option[value="-# "]'),
    'toolbar does not offer unsupported subtext',
  );
  blockFormat.value = '## ';
  blockFormat.dispatchEvent(new Event('change'));
  check(
    markdownInput.value.startsWith('## ') && textPreview(markdownInput.value).querySelector('h2'),
    'toolbar supports headings',
  );
  composer.add(10);
  let issues = composer.validate(false);
  check(
    issues.length === 1 && issues[0].input.getAttribute('aria-invalid') === 'false',
    'initial component error stays hidden',
  );
  const untouchedText = issues[0].input;
  check(
    untouchedText.validity.customError &&
      document.getElementById(untouchedText.id + '-error').hidden,
    'hidden error still blocks invalid data',
  );
  issues = composer.validate();
  check(
    issues.length === 1 &&
      issues[0].input.tagName === 'TEXTAREA' &&
      issues[0].input.getAttribute('aria-invalid') === 'true',
    'form interaction reveals component error',
  );
  const missingText = issues[0].input;
  missingText.value = 'fixed';
  missingText.dispatchEvent(new Event('input'));
  check(
    composer.validate().length === 0 && missingText.getAttribute('aria-invalid') === 'false',
    'fixing new component clears error',
  );
  composer.add(12);
  issues = composer.validate();
  const missingUrl = issues[0].input;
  missingUrl.value = 'example.com/image.png';
  missingUrl.dispatchEvent(new Event('input'));
  missingUrl.dispatchEvent(new Event('blur'));
  check(
    missingUrl.value === 'https://example.com/image.png' && composer.validate().length === 0,
    'nested URL autoformat updates model and clears error',
  );
  const handle = fields.querySelector('.block-handle');
  const block = handle.closest('.component-editor');
  const toggle = block.querySelector('.block-toggle');
  const body = block.querySelector('.component-body');
  handle.click();
  check(!body.hidden, 'handle click does not collapse block');
  check(
    !fields.querySelector('summary button, summary input, summary select, summary a'),
    'no interactive controls inside summaries',
  );
  toggle.click();
  check(
    body.hidden && toggle.getAttribute('aria-expanded') === 'false',
    'block collapses accessibly',
  );
  toggle.click();
  check(
    !body.hidden && toggle.getAttribute('aria-expanded') === 'true',
    'block expands accessibly',
  );
  fields.remove();
  const dragZone = document.createElement('div');
  dragZone.style.cssText = 'width:300px;display:grid;gap:14px';
  for (let i = 0; i < 2; i++) {
    const block = document.createElement('section');
    block.className = 'component-editor';
    const heading = document.createElement('div');
    heading.className = 'card-titlebar';
    heading.textContent = 'drag check';
    const body = document.createElement('div');
    body.style.height = '150px';
    block.append(heading, body);
    dragZone.append(block);
  }
  document.body.append(dragZone);
  const dragItem = dragZone.lastElementChild;
  const zoneHeight = dragZone.getBoundingClientRect().height;
  const dragTop = dragItem.getBoundingClientRect().top;
  const hooks = collapseDragZone(dragZone, '.component-editor');
  hooks.onChoose({ item: dragItem });
  check(
    [...dragZone.children].every((node) => node.classList.contains('drag-collapsed')),
    'drag collapses every item in its zone',
  );
  check(
    Math.abs(dragZone.getBoundingClientRect().height - zoneHeight) < 1,
    'drag reserves zone height',
  );
  check(
    Math.abs(dragItem.getBoundingClientRect().top - dragTop) < 1,
    'drag keeps grabbed item anchored',
  );
  hooks.onUnchoose({ item: dragItem });
  check(
    !dragZone.querySelector('.drag-collapsed') && !dragZone.style.minHeight,
    'drag restores open states and height',
  );
  dragZone.remove();

  const publishDialog = document.querySelector('#publish-dialog');
  const publishConfirm = document.querySelector('#publish-confirm');
  const confirmPublish = document.querySelector('#confirm-publish');
  const termsAccepted = localStorage.getItem('linkbed-terms-accepted') === 'true';
  document.querySelector('#publish-button').click();
  check(
    publishDialog.open &&
      !publishConfirm.checked &&
      confirmPublish.disabled === !termsAccepted &&
      publishConfirm.closest('label').hidden === termsAccepted,
    'publish requests agreement only when needed',
  );
  if (!termsAccepted)
    document
      .querySelector('#publish-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  check(
    publishDialog.open && !document.querySelector('#card-form').inert,
    'opening or rejecting unchecked publish does not start saving',
  );
  publishConfirm.click();
  check(!confirmPublish.disabled, 'checking acknowledgement enables final publish');
  publishDialog.querySelector('[data-close]').click();
  await new Promise((resolve) => publishDialog.addEventListener('close', resolve, { once: true }));
  check(!publishConfirm.checked && confirmPublish.disabled, 'closing publish clears confirmation');
  check(
    document.querySelector('#make-card').matches('a[href="#new"]') &&
      document.querySelector('#show-cards').matches('a[href="#cards"]'),
    'navigation uses links',
  );
  const header = document.querySelector('.site-header');
  const position = scrollY;
  const spacer = document.createElement('div');
  spacer.style.height = '100vh';
  document.body.append(spacer);
  scrollTo(0, 100);
  window.dispatchEvent(new Event('scroll'));
  check(
    header.inert && header.classList.contains('is-hidden'),
    'scrolled navigation is hidden and inert',
  );
  scrollTo(0, 20);
  window.dispatchEvent(new Event('scroll'));
  check(header.inert, 'scrolling up below top keeps navigation hidden');
  scrollTo(0, 0);
  window.dispatchEvent(new Event('scroll'));
  check(
    !header.inert && !header.classList.contains('is-hidden'),
    'navigation returns at exact top',
  );
  spacer.remove();
  scrollTo(0, position);
  window.dispatchEvent(new Event('scroll'));
  return { passed: 57 };
})();
