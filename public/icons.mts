export function icon(name: string): SVGSVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('class', 'icon');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '/icons.svg#' + name);
  node.append(use);
  return node;
}

export function mountIcons(root: ParentNode = document): void {
  root
    .querySelectorAll<HTMLElement>('[data-icon]')
    .forEach((node) => node.replaceWith(icon(node.dataset.icon ?? '')));
}
