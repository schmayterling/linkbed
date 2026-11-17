import { renderComponent } from './components.mjs';

const card = document.querySelector('#public-card');
const { component } = JSON.parse(document.getElementById('discord:component-embed').textContent);
let theme;
try {
  theme = localStorage.getItem('theme');
} catch {}
theme = theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = theme;
card.parentElement.dataset.previewTheme = theme;
renderComponent(card, component);
