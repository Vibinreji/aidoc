/**
 * Build-time document model: Markdown → sanitized sections with block ids (spec §4) → chunks (spec §10).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import type { Element, ElementContent, Root, Text } from 'hast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import { parse as parseYaml } from 'yaml';
import { sanitize, type SanitizeReport } from './sanitize.ts';
import { splitSentences } from '../text/sentences.ts';

export interface SectionModel {
  id: string;
  title: string;
  level: number;
  type: 'section' | 'frontmatter';
  children: ElementContent[];
  headingPath: string[];
}

export interface BlockModel {
  id: string;
  sectionId: string;
  text: string;
}

export interface DocumentModel {
  meta: { title: string; language: string; authors?: string[]; license?: string; created: string };
  sections: SectionModel[];
  blocks: BlockModel[];
  warnings: string[];
}

export interface ChunkModel {
  id: string;
  sectionId: string;
  headingPath: string[];
  text: string;
  blocks: string[];
  tokens: number;
}

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dt', 'dd', 'pre', 'blockquote', 'figcaption', 'caption', 'tr', 'summary', 'figure']);
const HEADING = /^h([1-6])$/;
const SPACED = new Set(['td', 'th', 'br', 'li', 'p', 'div', 'tr', 'dt', 'dd']);
const SECTION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Text of a node: like textContent, but SVG/MathML-free and with spaces at cell/line boundaries. */
export function textOf(n: ElementContent): string {
  if (n.type === 'text') return n.value;
  if (n.type !== 'element') return '';
  if (n.tagName === 'svg' || n.tagName === 'math' || n.tagName === 'img') return '';
  const inner = n.children.map(textOf).join('');
  return SPACED.has(n.tagName) ? ` ${inner} ` : inner;
}

function slug(s: string): string {
  return collapse(s).toLowerCase().normalize('NFKD').replace(/\p{Mn}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'section';
}

function stripHeadingId(h: Element): string | undefined {
  // Trailing "{#id}" in the last text node of a heading.
  const last = h.children[h.children.length - 1];
  if (last?.type !== 'text') return undefined;
  const m = /\s*\{#([A-Za-z0-9][A-Za-z0-9_.-]*)\}\s*$/.exec(last.value);
  if (!m) return undefined;
  (last as Text).value = last.value.slice(0, m.index);
  return m[1];
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml' };

/** Inline local images as data: URLs (before sanitizing, which removes all other sources). */
function inlineImages(nodes: ElementContent[], baseDir: string, warnings: string[]): void {
  for (const n of nodes) {
    if (n.type !== 'element') continue;
    if (n.tagName === 'img' && typeof n.properties.src === 'string' && !/^[a-z]+:/i.test(n.properties.src)) {
      const p = resolve(baseDir, decodeURI(n.properties.src));
      const mime = MIME[extname(p).toLowerCase()];
      if (mime && existsSync(p)) n.properties.src = `data:${mime};base64,${readFileSync(p).toString('base64')}`;
      else warnings.push(`image not found or unsupported: ${n.properties.src}`);
    }
    inlineImages(n.children, baseDir, warnings);
  }
}

function assignBlocks(nodes: ElementContent[], next: () => string, out: { id: string; el: Element }[]): boolean {
  // Returns true if any descendant got a block id. Ids go on the innermost eligible element (§4.5).
  let any = false;
  for (const n of nodes) {
    if (n.type !== 'element' || n.tagName === 'svg' || n.tagName === 'math') continue;
    const inner = assignBlocks(n.children, next, out);
    if (!inner && BLOCK_TAGS.has(n.tagName)) {
      const id = next();
      n.properties.dataAidocB = id;
      out.push({ id, el: n });
      any = true;
    } else if (inner) any = true;
  }
  return any;
}

function blockText(el: Element): string {
  if (el.tagName === 'figure') {
    // Figure without caption: alt text or SVG <title> (§4.5.4).
    const find = (n: ElementContent): string => {
      if (n.type !== 'element') return '';
      if (n.tagName === 'img') return String(n.properties.alt ?? '');
      if (n.tagName === 'title') return n.children.map(textOf).join('');
      return n.children.map(find).join(' ');
    };
    return collapse(el.children.map(find).join(' '));
  }
  return collapse(el.children.map(textOf).join(''));
}

export function parseMarkdown(path: string): DocumentModel {
  let src = readFileSync(path, 'utf8');
  let fm: Record<string, unknown> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(src);
  if (m) {
    fm = (parseYaml(m[1]!) as Record<string, unknown>) ?? {};
    src = src.slice(m[0].length);
  }
  const mdast = unified().use(remarkParse).use(remarkGfm).parse(src);
  const hast = unified().use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw).runSync(mdast) as Root;
  const warnings: string[] = [];
  inlineImages(hast.children as ElementContent[], dirname(path), warnings);
  const report: SanitizeReport = { warnings };
  sanitize(hast, report);

  const nodes = hast.children as ElementContent[];
  const firstH1 = nodes.find((n): n is Element => n.type === 'element' && n.tagName === 'h1');
  const title = String(fm.title ?? (firstH1 ? collapse(firstH1.children.map(textOf).join('')) : 'Untitled'));

  // Split the flat top-level node list into sections at headings.
  const sections: SectionModel[] = [];
  const used = new Set<string>();
  const uniq = (id: string) => {
    let u = id;
    for (let i = 2; used.has(u); i++) u = `${id}-${i}`;
    used.add(u);
    return u;
  };
  let cur: SectionModel | undefined;
  for (const n of nodes) {
    const hm = n.type === 'element' ? HEADING.exec(n.tagName) : null;
    if (n.type === 'element' && hm) {
      const explicit = stripHeadingId(n);
      const text = collapse(n.children.map(textOf).join(''));
      if (explicit && !SECTION_ID.test(explicit)) throw new Error(`invalid section id {#${explicit}}`);
      cur = { id: uniq(explicit ?? slug(text)), title: text, level: Number(hm[1]), type: 'section', children: [n], headingPath: [] };
      sections.push(cur);
      continue;
    }
    if (n.type === 'text' && !n.value.trim()) {
      cur?.children.push(n);
      continue;
    }
    if (!cur) {
      cur = { id: uniq('frontmatter'), title, level: 1, type: 'frontmatter', children: [], headingPath: [] };
      sections.push(cur);
    }
    if (n.type === 'text') cur.children.push({ type: 'element', tagName: 'p', properties: {}, children: [n] });
    else cur.children.push(n);
  }

  // Heading paths (§4.4.5).
  const stack: string[] = [];
  for (const s of sections) {
    stack.length = s.level - 1;
    for (let i = 0; i < stack.length; i++) stack[i] ??= '';
    stack[s.level - 1] = s.title;
    s.headingPath = stack.filter((t) => t !== '');
  }

  // Block ids in document order.
  let counter = 0;
  const blocks: BlockModel[] = [];
  for (const s of sections) {
    const found: { id: string; el: Element }[] = [];
    assignBlocks(s.children, () => `b${counter++}`, found);
    for (const f of found) {
      const text = blockText(f.el);
      blocks.push({ id: f.id, sectionId: s.id, text });
    }
  }

  const created = fm.created instanceof Date ? fm.created.toISOString().slice(0, 10) : String(fm.created ?? new Date().toISOString().slice(0, 10));
  const authors = Array.isArray(fm.authors) ? fm.authors.map(String) : undefined;
  return {
    meta: { title, language: String(fm.language ?? 'en'), created, ...(authors ? { authors } : {}), ...(fm.license ? { license: String(fm.license) } : {}) },
    sections,
    blocks,
    warnings,
  };
}

export interface ChunkOptions {
  countTokens: (text: string) => number;
  language: string;
  min?: number;
  max?: number;
}

/** Chunk along block boundaries within sections (spec §10.6–10.7). */
export function chunkDocument(doc: DocumentModel, o: ChunkOptions): ChunkModel[] {
  const min = o.min ?? 150;
  const max = o.max ?? 300;
  const raw: { sectionId: string; parts: { block: string; text: string }[] }[] = [];
  const bySection = new Map<string, BlockModel[]>();
  for (const b of doc.blocks) {
    if (!b.text) continue;
    (bySection.get(b.sectionId) ?? bySection.set(b.sectionId, []).get(b.sectionId)!).push(b);
  }
  for (const s of doc.sections) {
    const bl = bySection.get(s.id) ?? [];
    const groups: { block: string; text: string; tokens: number }[][] = [];
    let cur: { block: string; text: string; tokens: number }[] = [];
    let curTok = 0;
    const flush = () => {
      if (cur.length) groups.push(cur);
      cur = [];
      curTok = 0;
    };
    for (const b of bl) {
      const t = o.countTokens(b.text);
      if (t > max) {
        flush();
        // Split an oversized block at sentence boundaries.
        let piece: string[] = [];
        let pt = 0;
        for (const sen of splitSentences(b.text, o.language)) {
          const st = o.countTokens(sen);
          if (pt + st > max && piece.length) {
            groups.push([{ block: b.id, text: piece.join(' '), tokens: pt }]);
            piece = [];
            pt = 0;
          }
          piece.push(sen);
          pt += st;
        }
        if (piece.length) groups.push([{ block: b.id, text: piece.join(' '), tokens: pt }]);
        continue;
      }
      if (curTok + t > max && cur.length) flush();
      cur.push({ block: b.id, text: b.text, tokens: t });
      curTok += t;
    }
    flush();
    // Merge a short tail into the previous chunk of the same section when it stays reasonable.
    if (groups.length >= 2) {
      const last = groups[groups.length - 1]!;
      const prev = groups[groups.length - 2]!;
      const lt = last.reduce((a, c) => a + c.tokens, 0);
      const ptok = prev.reduce((a, c) => a + c.tokens, 0);
      if (lt < min / 2 && lt + ptok <= max + min / 2 && last[0]!.block !== prev[prev.length - 1]!.block) {
        prev.push(...last);
        groups.pop();
      }
    }
    for (const g of groups) raw.push({ sectionId: s.id, parts: g });
  }
  const sectionById = new Map(doc.sections.map((s) => [s.id, s]));
  return raw.map((r, i) => {
    const text = r.parts.map((p) => p.text).join('\n');
    const blocks: string[] = [];
    for (const p of r.parts) if (blocks[blocks.length - 1] !== p.block) blocks.push(p.block);
    return { id: `c${i}`, sectionId: r.sectionId, headingPath: sectionById.get(r.sectionId)!.headingPath, text, blocks, tokens: o.countTokens(text) };
  });
}

export const indexText = (c: { headingPath: string[]; text: string }) => `${c.headingPath.join('\n')}\n\n${c.text}`;
