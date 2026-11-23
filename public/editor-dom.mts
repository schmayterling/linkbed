export function $<T extends HTMLElement = HTMLElement>(
  selector: string,
  type?: { new (): T },
  root: ParentNode = document,
): T {
  const node = root.querySelector<T>(selector);
  if (!node || (type && !(node instanceof type)))
    throw new Error('missing editor element: ' + selector);
  return node;
}

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
