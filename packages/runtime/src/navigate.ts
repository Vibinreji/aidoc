/** Scrolling to cited passages and highlighting them (spec §15.4). */

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
let lastBlock: Element | null = null;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

export function sectionElements(): HTMLElement[] {
  const main = document.getElementById('aidoc-content');
  return main ? Array.from(main.querySelectorAll<HTMLElement>(':scope > section[data-aidoc-id]')) : [];
}

/**
 * The section currently in view: the section of the passage the reader last jumped to while it is
 * still on screen; otherwise the last section whose top is above the middle of the viewport.
 */
export function currentSectionId(): string | undefined {
  if (lastBlock?.isConnected) {
    const r = lastBlock.getBoundingClientRect();
    if (r.bottom > 0 && r.top < window.innerHeight) {
      const sec = lastBlock.closest<HTMLElement>('section[data-aidoc-id]');
      if (sec) return sec.dataset.aidocId;
    }
  }
  const secs = sectionElements();
  let cur = secs[0];
  const line = window.innerHeight * 0.5;
  for (const s of secs) {
    if (s.getBoundingClientRect().top <= line) cur = s;
    else break;
  }
  return cur?.dataset.aidocId;
}

function blockEl(blockId: string): HTMLElement | null {
  return /^b\d+$/.test(blockId) ? document.querySelector<HTMLElement>(`[data-aidoc-b="${blockId}"]`) : null;
}

export function sectionEl(sectionId: string): HTMLElement | null {
  return sectionElements().find((s) => s.dataset.aidocId === sectionId) ?? null;
}

/** Find a sentence inside an element, ignoring whitespace differences. Returns a DOM Range. */
function findRange(root: HTMLElement, sentence: string): Range | null {
  const target = sentence.replace(/\s+/g, ' ').trim();
  if (!target) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let flat = '';
  const map: { node: Text; offset: number }[] = [];
  let prevSpace = true;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (n.parentElement?.closest('svg, math')) continue;
    const v = n.data;
    for (let i = 0; i < v.length; i++) {
      const ch = v[i]!;
      if (/\s/.test(ch)) {
        if (prevSpace) continue;
        flat += ' ';
        prevSpace = true;
      } else {
        flat += ch;
        prevSpace = false;
      }
      map.push({ node: n, offset: i });
    }
  }
  const at = flat.indexOf(target);
  if (at < 0) return null;
  const start = map[at]!;
  const end = map[at + target.length - 1]!;
  const r = document.createRange();
  r.setStart(start.node, start.offset);
  r.setEnd(end.node, end.offset + 1);
  return r;
}

export function goTo(target: { blockId?: string; sectionId?: string }, sentence?: string): boolean {
  const el = (target.blockId && blockEl(target.blockId)) || (target.sectionId && sectionEl(target.sectionId)?.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6')) || (target.sectionId && sectionEl(target.sectionId));
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  lastBlock?.classList.remove('aidoc-hl');
  el.classList.add('aidoc-hl');
  lastBlock = el;
  const hl = (globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  hl?.delete('aidoc-sentence');
  if (sentence && hl && HighlightCtor) {
    const r = findRange(el, sentence);
    if (r) hl.set('aidoc-sentence', new HighlightCtor(r));
  }
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    el.classList.remove('aidoc-hl');
    hl?.delete('aidoc-sentence');
  }, 6000);
  // Make the target reachable for keyboard and screen-reader users.
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  return true;
}
