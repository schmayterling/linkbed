import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('public/vendor', { recursive: true });
const editorFiles = [
  'lib/codemirror.js',
  'mode/javascript/javascript.js',
  'addon/edit/closebrackets.js',
  'addon/edit/matchbrackets.js',
];
writeFileSync(
  'public/vendor/codemirror.mjs',
  editorFiles.map((file) => readFileSync('node_modules/codemirror/' + file, 'utf8')).join('\n') +
    '\nexport default globalThis.CodeMirror;\n',
);
copyFileSync('node_modules/codemirror/lib/codemirror.css', 'public/vendor/codemirror.css');
copyFileSync('node_modules/codemirror/LICENSE', 'public/vendor/codemirror.LICENSE');

const names = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'eye-off',
  'code',
  'apple',
  'arrow-down',
  'arrow-up',
  'cat',
  'chevron-down',
  'code-xml',
  'copy',
  'download',
  'external-link',
  'file-json',
  'flag',
  'grip-vertical',
  'hand',
  'heart',
  'badge-check',
  'house',
  'lightbulb',
  'link',
  'menu',
  'moon',
  'plus',
  'smile',
  'square-pen',
  'sun',
  'trash-2',
  'volleyball',
  'x',
];
const symbols = names.map((name) => {
  const source = readFileSync('node_modules/lucide-static/icons/' + name + '.svg', 'utf8');
  return source
    .slice(source.indexOf('<svg'))
    .replace(
      /<svg[^>]*>/,
      '<symbol id="' +
        name +
        '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    )
    .replace('</svg>', '</symbol>');
});
writeFileSync(
  'public/icons.svg',
  '<svg xmlns="http://www.w3.org/2000/svg">' + symbols.join('\n') + '</svg>\n',
);
copyFileSync('node_modules/lucide-static/LICENSE', 'public/vendor/lucide.LICENSE');
copyFileSync('node_modules/lucide-static/icons/chevron-down.svg', 'public/vendor/chevron-down.svg');
copyFileSync('node_modules/@melloware/coloris/dist/esm/coloris.js', 'public/vendor/coloris.mjs');
copyFileSync('node_modules/@melloware/coloris/dist/coloris.css', 'public/vendor/coloris.css');
copyFileSync('node_modules/@melloware/coloris/LICENSE', 'public/vendor/coloris.LICENSE');
copyFileSync('node_modules/sortablejs/modular/sortable.esm.js', 'public/vendor/sortable.mjs');
copyFileSync('node_modules/sortablejs/LICENSE', 'public/vendor/sortable.LICENSE');
copyFileSync('node_modules/emoji-picker-element/picker.js', 'public/vendor/emoji-picker.mjs');
copyFileSync('node_modules/emoji-picker-element/database.js', 'public/vendor/emoji-database.mjs');
copyFileSync('node_modules/emoji-picker-element/LICENSE', 'public/vendor/emoji-picker.LICENSE');
copyFileSync(
  'node_modules/emoji-picker-element-data/en/emojibase/data.json',
  'public/vendor/emoji-data.json',
);
copyFileSync('node_modules/emoji-picker-element-data/LICENSE', 'public/vendor/emoji-data.LICENSE');
// Load the picker's own styles from a file so the site's strict CSP stays intact.
let picker = readFileSync('public/vendor/emoji-picker.mjs', 'utf8').replace(
  "'./database.js'",
  "'./emoji-database.mjs'",
);
// The pinned emoji-picker-element build includes these generated style and font declarations.
const baseStyles = picker.match(/^var baseStyles = (".*");$/m) as RegExpMatchArray;
// FONT_FAMILY is emitted as concatenated single-quoted strings in the pinned build.
const fontFamily = picker.match(/^const FONT_FAMILY = ([\s\S]*?);/m) as RegExpMatchArray;
// The captured declaration contains at least one single-quoted font string.
const font = (fontFamily[1].match(/'[^']*'/g) as RegExpMatchArray)
  .map((part) => part.slice(1, -1))
  .join('');
const style: unknown = JSON.parse(baseStyles[1]);
writeFileSync('public/vendor/emoji-picker.css', style + ':host{--emoji-font-family:' + font + '}');
picker = picker
  .replace(baseStyles[0], '')
  .replace(/^const EXTRA_STYLES = .*;$/m, '')
  .replace(
    "const style = document.createElement('style');\n    style.textContent = baseStyles + EXTRA_STYLES;",
    "const style = document.createElement('link');\n    style.rel = 'stylesheet';\n    style.href = '/vendor/emoji-picker.css';",
  );
picker = picker.replace(
  'targetNode.setAttribute(attributeName, newValue);',
  "if (attributeName === 'style') targetNode.style.cssText = newValue;\n        else targetNode.setAttribute(attributeName, newValue);",
);
writeFileSync('public/vendor/emoji-picker.mjs', picker);
console.log('vendored editor, pickers, sortable, and ' + names.length + ' Lucide icons');
