import { icon } from './icons.mts';

const found = document.querySelector('#theme-toggle');
if (!found) throw new Error('missing #theme-toggle');
const toggle: Element = found;
function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme;
  toggle.setAttribute('aria-label', 'switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode');
  toggle.replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon'));
}
let saved: string | null = null;
try {
  saved = localStorage.getItem('theme');
} catch {}
applyTheme(saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
toggle.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try {
    localStorage.setItem('theme', theme);
  } catch {}
});
