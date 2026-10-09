/**
 * Build-time content sanitizer (spec §7): an allowlist over a hast tree.
 * Forbidden elements are dropped with their content; unknown elements are unwrapped.
 */
import type { Element, ElementContent, Nodes, Parents, Root } from 'hast';
import { find, html, svg } from 'property-information';

const HTML_ELEMENTS = new Set(
  ('a abbr b bdi bdo blockquote br caption cite code col colgroup data dd del details dfn div dl dt em figcaption figure ' +
    'h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q rp rt ruby s samp section small span strong sub summary sup ' +
    'table tbody td tfoot th thead time tr u ul var wbr').split(' '),
);
const MATH_ELEMENTS = new Set(
  ('math mi mn mo ms mtext mspace mrow mfrac msqrt mroot mstyle merror mpadded mphantom msub msup msubsup munder mover ' +
    'munderover mmultiscripts mprescripts mtable mtr mtd semantics annotation').split(' '),
);
const SVG_ELEMENTS = new Set(
  ('svg g defs title desc symbol use path rect circle ellipse line polyline polygon text tspan textPath image marker ' +
    'linearGradient radialGradient stop pattern clipPath mask filter feBlend feColorMatrix feComposite feDropShadow ' +
    'feFlood feGaussianBlur feMerge feMergeNode feMorphology feOffset').split(' '),
);
/** Dropped together with their content. */
const DROP = new Set(
  ('script style noscript template slot iframe frame frameset object embed applet portal fencedframe form input button ' +
    'select textarea option optgroup datalist output fieldset legend label dialog base link meta audio video source ' +
    'track picture canvas map area head title foreignObject animate animateMotion animateTransform set discard feImage ' +
    'annotation-xml').split(' '),
);
const GLOBAL_ATTRS = new Set(['id', 'class', 'title', 'lang', 'dir', 'role', 'hidden', 'translate']);
const PER_ELEMENT: Record<string, string[]> = {
  a: ['href', 'rel', 'target', 'hreflang', 'type'],
  img: ['src', 'alt', 'width', 'height', 'decoding', 'loading'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  td: ['colspan', 'rowspan', 'headers'],
  th: ['colspan', 'rowspan', 'headers', 'scope', 'abbr'],
  col: ['span'],
  colgroup: ['span'],
  time: ['datetime'],
  data: ['value'],
  details: ['open'],
  bdo: ['dir'],
};
const MATH_ATTRS = new Set(
  ('display mathvariant displaystyle scriptlevel form fence separator stretchy symmetric largeop movablelimits lspace ' +
    'rspace minsize maxsize accent accentunder linethickness width height depth voffset encoding').split(' '),
);
const SVG_ATTRS = new Set(
  ('x y x1 y1 x2 y2 cx cy r rx ry width height d points pathLength viewBox preserveAspectRatio transform dx dy rotate ' +
    'textLength lengthAdjust startOffset xmlns xmlns:xlink version fill fill-opacity fill-rule stroke stroke-width ' +
    'stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity color ' +
    'display visibility font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline ' +
    'baseline-shift letter-spacing word-spacing text-decoration clip-path clip-rule mask filter marker-start marker-mid ' +
    'marker-end stop-color stop-opacity flood-color flood-opacity vector-effect paint-order shape-rendering overflow ' +
    'offset gradientUnits gradientTransform spreadMethod fx fy fr patternUnits patternContentUnits patternTransform ' +
    'clipPathUnits maskUnits maskContentUnits markerWidth markerHeight markerUnits refX refY orient filterUnits ' +
    'primitiveUnits in in2 result mode operator k1 k2 k3 k4 values type stdDeviation edgeMode radius href xlink:href').split(' '),
);
const URL_REF_ATTRS = new Set(['fill', 'stroke', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end']);
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i;
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface SanitizeReport {
  warnings: string[];
}

type Space = 'html' | 'svg' | 'math';

function attrNameOf(prop: string, space: Space): string {
  return find(space === 'svg' ? svg : html, prop).attribute;
}

function cleanUrl(u: string): string {
  // HTML URL parser: strip leading/trailing C0 controls and spaces, remove tab/newline.
  return u.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
}

function sanitizeElement(el: Element, space: Space, report: SanitizeReport): ElementContent[] {
  const name = el.tagName;
  let childSpace: Space = space;
  if (DROP.has(name) && !(space === 'svg' && name === 'title')) {
    report.warnings.push(`removed <${name}>`);
    return [];
  }
  let allowed: boolean;
  if (name === 'svg') {
    allowed = true;
    childSpace = 'svg';
  } else if (name === 'math') {
    allowed = true;
    childSpace = 'math';
  } else if (space === 'svg') allowed = SVG_ELEMENTS.has(name);
  else if (space === 'math') allowed = MATH_ELEMENTS.has(name);
  else allowed = HTML_ELEMENTS.has(name) && !name.includes('-');
  const elSpace: Space = name === 'svg' ? 'svg' : name === 'math' ? 'math' : space;

  const children = sanitizeChildren(el.children, childSpace, report, name === 'annotation');
  if (!allowed) {
    report.warnings.push(`unwrapped <${name}>`);
    return children;
  }

  const props: Element['properties'] = {};
  for (const [prop, value] of Object.entries(el.properties ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    const attr = attrNameOf(prop, elSpace);
    const lower = attr.toLowerCase();
    let ok =
      GLOBAL_ATTRS.has(lower) ||
      lower.startsWith('aria-') ||
      (elSpace === 'html' && (PER_ELEMENT[name] ?? []).includes(lower)) ||
      (elSpace === 'svg' && SVG_ATTRS.has(attr)) ||
      (elSpace === 'math' && MATH_ATTRS.has(lower));
    if (lower.startsWith('on') || lower === 'style' || lower.startsWith('data-')) ok = false;
    if (!ok) {
      if (lower === 'style') report.warnings.push(`removed style attribute on <${name}> (blocked by CSP; use presentation attributes or classes)`);
      continue;
    }
    let v = Array.isArray(value) ? value.join(' ') : String(value);
    if (/^\s*(javascript|vbscript|file):/i.test(cleanUrl(v))) {
      report.warnings.push(`removed ${attr} with forbidden URL scheme`);
      continue;
    }
    if (lower === 'id' && (!ID_RE.test(v) || /^aidoc-/i.test(v))) {
      report.warnings.push(`removed invalid id "${v}"`);
      continue;
    }
    if (elSpace === 'html' && name === 'a' && lower === 'href') {
      const u = cleanUrl(v);
      if (!(u.startsWith('#') || /^(https?|mailto):/i.test(u))) {
        report.warnings.push(`removed link href "${v}"`);
        continue;
      }
      v = u;
    }
    if (elSpace === 'html' && name === 'a' && lower === 'target' && v !== '_blank') continue;
    if (elSpace === 'html' && name === 'img' && lower === 'src' && !DATA_IMAGE.test(v)) {
      report.warnings.push(`removed non-data image source`);
      continue;
    }
    if (elSpace === 'svg' && (attr === 'href' || attr === 'xlink:href')) {
      const good = (name === 'use' || name === 'textPath') ? /^#[A-Za-z][\w-]*$/.test(v) : name === 'image' ? DATA_IMAGE.test(v) : false;
      if (!good) {
        report.warnings.push(`removed svg ${attr} on <${name}>`);
        continue;
      }
    }
    if (elSpace === 'svg' && URL_REF_ATTRS.has(attr) && /url\(/i.test(v) && !/^\s*url\(\s*#[A-Za-z][\w-]*\s*\)/.test(v)) {
      report.warnings.push(`removed external url() in ${attr}`);
      continue;
    }
    props[prop] = Array.isArray(value) ? value : v;
  }
  if (elSpace === 'html' && name === 'a' && typeof props.href === 'string' && !props.href.startsWith('#')) {
    props.rel = ['noopener', 'noreferrer'];
  }
  if (elSpace === 'html' && name === 'img' && !props.src) return [];
  return [{ ...el, properties: props, children }];
}

function sanitizeChildren(nodes: ElementContent[], space: Space, report: SanitizeReport, textOnly = false): ElementContent[] {
  const out: ElementContent[] = [];
  for (const n of nodes) {
    if (n.type === 'comment') continue;
    if (n.type === 'text') {
      out.push(n);
      continue;
    }
    if (n.type === 'element') {
      if (textOnly) continue;
      out.push(...sanitizeElement(n, space, report));
    }
  }
  return out;
}

export function sanitize(root: Root | Parents, report: SanitizeReport = { warnings: [] }): SanitizeReport {
  const kids = (root.children as Nodes[]).filter((n): n is ElementContent => n.type === 'element' || n.type === 'text' || n.type === 'comment');
  (root as Root).children = sanitizeChildren(kids, 'html', report);
  return report;
}
