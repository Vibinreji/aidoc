/** Tiny DOM helpers. Text is always inserted as text (spec §15.1.4); never innerHTML. */

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function button(label: Child | Child[], onClick: () => void, attrs: Record<string, string | undefined> = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', ...attrs }, ...(Array.isArray(label) ? label : [label]));
  b.addEventListener('click', onClick);
  return b;
}

/** Paragraphs from plain text: blank lines separate paragraphs (spec §14.1). */
export function paragraphs(text: string): HTMLElement[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => h('p', {}, p));
}
