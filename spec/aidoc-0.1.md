# aidoc 0.1: Self-contained, offline, askable HTML documents

- **Version:** 0.1 (format), first runtime release 0.1.0
- **Status:** Draft
- **Date:** 2026-10-08
- **Licence:** This specification is licensed under the Creative Commons Attribution 4.0 International License (CC BY 4.0), <https://creativecommons.org/licenses/by/4.0/>. The JSON Schemas in `spec/schemas/` are part of this specification and share its licence.
- **Schemas:** `https://aidoc.dev/schema/0.1/{manifest,chunks,bm25,generated,graph,embedder-header}.json`

---

## 1. Introduction

An **aidoc** is a single HTML file, conventionally named `*.ai.html`, that a person opens by double-clicking. It shows a normal, readable document and, beside it, an **"Ask this document"** panel. The panel offers search, extractive answers with citations, pre-written summaries, simple explanations, quizzes, an FAQ and a concept map.

The file contains **no language model**. All expensive AI work (summaries, FAQ, quizzes, concept graph, embeddings of the document) happens when the file is built. Its output is stored as data that the author can review. When the file is read, only cheap, deterministic work happens: BM25 scoring, a static embedder (token-vector lookup, mean, L2 normalization), dot products and sentence extraction.

### 1.1 Goals

1. **One file.** Everything the document needs is inside the file. No sidecar files, no installation.
2. **Offline by construction.** The Content Security Policy blocks all network access. The file behaves the same with or without a network connection.
3. **Safe to open.** Exactly one script runs: the official aidoc runtime, pinned by hash. Content is sanitized so that it cannot run code or reach the network.
4. **Honest.** Readers can always see whether an answer was *found in the document* or *prepared by the author* ahead of time. When the document does not cover a question, the panel says so.
5. **Durable.** The document remains readable as plain HTML if the runtime fails, is blocked, or JavaScript is disabled.
6. **Verifiable.** A validator can check every rule in this specification without running the runtime.

### 1.2 Non-goals

- Generative answers at read time. There is no LLM, local or remote, in an aidoc.
- Authenticity. Block hashes detect corruption, not tampering; anyone can edit a file and recompute them. Signatures are out of scope for 0.1.
- Arbitrary interactive content. Authors cannot ship their own scripts.
- Confidentiality. An aidoc is not encrypted.
- PDF fidelity. PDF rendering, and any CSP profile it needs, is left to a later version (§6.3).

### 1.3 Notational conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY" and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals, as shown here.

Sections marked *(informative)* and all notes, remarks and examples are non-normative. Everything else is normative.

`sha256-b64(x)` means the SHA-256 digest of the byte sequence `x`, encoded as standard base64 with padding (RFC 4648 §4; always 44 characters). "UTF-8 bytes of a string" means the UTF-8 encoding with no BOM.

## 2. Terminology

- **Document (file):** an `.ai.html` file conforming to this specification.
- **Builder:** software that produces documents from source material (Markdown, DOCX, …) plus reviewed generated content.
- **Runtime:** the official aidoc JavaScript program embedded in the document as its single executable script. It implements the Ask panel.
- **Reader:** any software that interprets a document's data blocks for a user. The embedded runtime is the primary reader; others include browser extensions and command-line tools.
- **Validator:** software that checks a document against this specification.
- **Content:** the human-readable document inside `<main id="aidoc-content">`.
- **Section:** a `<section>` element in the content, identified by `data-aidoc-id`.
- **Block element:** a content element carrying a `data-aidoc-b` id. It is the smallest addressable unit for citations.
- **Data block:** an inert `<script>` element whose `type` is an `application/aidoc-…` MIME type. Browsers never execute it.
- **Chunk:** a retrieval unit of text, made of one or more consecutive block elements within one section.
- **Generated content:** summaries, simple explanations, key points, quizzes and FAQ entries produced before or at build time, typically with AI assistance, and stored as data.
- **Extracted content:** text taken verbatim from the document's chunks at read time.
- **Stored text** of a data block: the exact string content of the `<script>` element as it appears in the file (its `textContent`).

## 3. File identification

1. A document's file name SHOULD end in `.ai.html`. Tools MUST NOT rely on the file name alone.
2. A document MUST be served or saved as `text/html` and MUST be encoded in UTF-8. It MUST NOT start with a byte order mark.
3. The `<head>` MUST contain `<meta name="generator" content="aidoc X.Y.Z">`, where `X.Y.Z` is the semantic version of the runtime release embedded in the file. Its `X.Y` MUST equal the format version (`0.1` for this specification). Example: `<meta name="generator" content="aidoc 0.1.0">`.
4. The manifest data block (§9) MUST have an `aidoc` field equal to the format version, `"0.1"`.
5. To sniff a file, tools SHOULD look for the generator meta within the first 4096 bytes and then confirm by parsing the manifest. The manifest is authoritative.

## 4. Document structure

### 4.1 Overall shape

A document MUST be an HTML document in no-quirks mode with exactly this top-level shape (whitespace between elements is permitted; comments are not, see §7.6):

```html
<!DOCTYPE html>
<html lang="{manifest.language}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="{CSP, §6}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="aidoc 0.1.0">
<title>{manifest.title}</title>
<style>{all CSS: runtime and document}</style>
</head>
<body>
<main id="aidoc-content">
  <section data-aidoc-id="…" data-aidoc-type="…"> … </section>
  …
</main>
<script type="application/aidoc-manifest+json" id="aidoc-manifest">{…}</script>
<script type="application/aidoc-chunks+json" id="aidoc-chunks">[…]</script>
… other data blocks (§8) …
<script>{official runtime}</script>
</body>
</html>
```

### 4.2 Head

1. `<head>` MUST contain exactly these six elements, in this order and with no others:
   1. `<meta charset="utf-8">` (the value is ASCII case-insensitive);
   2. the CSP `<meta http-equiv="Content-Security-Policy">` (§6);
   3. `<meta name="viewport" content="width=device-width, initial-scale=1">`;
   4. the generator meta (§3);
   5. `<title>`, whose text SHOULD equal `manifest.title`;
   6. exactly one `<style>` element with no attributes.
2. The charset meta MUST lie within the first 1024 bytes of the file. The CSP meta MUST come before any element that could load or run anything. Both rules hold automatically when the order above is followed.
3. The single `<style>` element MUST contain all CSS of the document, including the runtime's CSS. Its text MUST NOT contain `@import`, or `url(` with any scheme other than `data:`. No other `<style>` element may appear anywhere in the file, including inside SVG.
4. `<html>` MUST have a `lang` attribute equal to `manifest.language`. It MAY have `dir`. It MUST NOT have other attributes.

### 4.3 Body

1. `<body>` MUST have no attributes. Its element children MUST be, in order: one `<main id="aidoc-content">`, then one or more data blocks (§8), then exactly one runtime `<script>` as the last element child.
2. The runtime `<script>` MUST have no attributes and no `src`. Its text MUST NOT contain the sequences `</script` or `<!--` (ASCII case-insensitive).
3. The runtime builds its user interface by creating DOM nodes at load time. A document MUST NOT contain pre-rendered UI markup outside `<main>`.

### 4.4 Content and sections

1. Every element child of `<main>` MUST be a `<section>` element. Sections MUST NOT be nested.
2. Each section MUST carry:
   - `data-aidoc-id`: a section id matching `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`, unique within the document;
   - `data-aidoc-type`: one of `section`, `frontmatter`, `abstract`, `appendix`, `references`. Readers MUST treat unknown values as `section`.
3. The sections' ids, in document order, MUST equal `manifest.sections[*].id` in order.
4. A section SHOULD begin with exactly one heading element (`h1`–`h6`). Its text content, with whitespace collapsed and trimmed, MUST equal `manifest.sections[i].title`, and its level MUST equal `manifest.sections[i].level`. A section without a heading (for example, front matter before the first heading) MUST have `level` 1 and SHOULD have the document title as its `title`.
5. The heading hierarchy is expressed by `level`, not by nesting. The **heading path** of a section is the list of titles of the nearest preceding sections with levels 1, 2, … up to the section's own level, ending with its own title.

### 4.5 Block elements

1. Every text-bearing leaf block in the content MUST carry `data-aidoc-b="b<N>"`, where `<N>` is a non-negative decimal integer with no leading zeros. Block ids MUST be unique in the document and SHOULD be assigned sequentially in document order starting at `b0`.
2. Elements eligible for `data-aidoc-b` are `p`, `h1`–`h6`, `li`, `dt`, `dd`, `pre`, `blockquote`, `figcaption`, `caption`, `tr`, `summary` and `figure`. An element MUST NOT carry `data-aidoc-b` if one of its descendants does (ids go on the innermost eligible element). For example, `<li><p>…</p></li>` puts the id on the `p`.
3. Content text that is not inside any block element (for example, bare text directly in a `<section>` or a `<div>`) MUST NOT occur. Builders MUST wrap such text in a `<p>`.
4. A `figure` that contains an image or SVG and no `figcaption` carries the id itself, so that it can be cited. Its text for chunking (§10) is the `alt` text or the SVG `<title>`.

## 5. Conformance classes

- A **conforming document** satisfies every MUST in §§3–14 and §16 that applies to documents.
- A **conforming builder** produces only conforming documents.
- A **conforming reader** satisfies §15.
- A **conforming validator** satisfies §16.

A document MUST embed an **official runtime**: a runtime release published by the aidoc project, identified by its version and `sha256`. A file that is conforming in every respect except that its runtime is not official is a *well-formed, unofficial* document. Validators MUST report this (§16).

## 6. Content Security Policy

### 6.1 Placement

The policy MUST be delivered by the second element of `<head>` (§4.2):

```html
<meta http-equiv="Content-Security-Policy" content="…">
```

There MUST be exactly one CSP meta. Directives that are ignored in a `<meta>` policy (`frame-ancestors`, `sandbox`, `report-uri`, `report-to`) MUST NOT appear.

### 6.2 The "text" profile (normative)

For `manifest.csp.profile = "text"`, the `content` attribute MUST be exactly the following string, with single spaces and no trailing semicolon:

```
default-src 'none'; script-src 'sha256-<runtime>'; style-src 'sha256-<style>'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'
```

- `<runtime>` is `sha256-b64` of the UTF-8 bytes of the runtime `<script>` element's text, exactly as stored. It MUST equal `manifest.runtime.sha256`.
- `<style>` is `sha256-b64` of the UTF-8 bytes of the single `<style>` element's text, exactly as stored.

Rationale (from measurements, see `docs/decisions.md` D-02): this policy blocks fetch, XHR, WebSocket, EventSource, `sendBeacon`, remote images, dynamic import, workers, frames, CSS `url()` loads and reads of other `file://` paths in Chromium, Firefox and WebKit. Inert data blocks remain readable. `style="…"` attributes are blocked, while SVG presentation attributes and CSSOM changes made by the runtime keep working. No fonts are embedded (system fonts only), so there is no `font-src`.

### 6.3 Future profiles (informative)

0.1 defines only the `"text"` profile. A later version is expected to add a `"pdf"` profile for embedded PDF rendering. Based on D-02, it would add only what PDF rendering is measured to need, out of `'wasm-unsafe-eval'` in `script-src`, `worker-src blob:` and `blob:` in `img-src`. Every future profile keeps the invariants of §6.4.

### 6.4 Invariants for every profile

In every profile, present and future:

1. `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'` and `default-src 'none'` MUST be present.
2. `script-src` MUST contain exactly one hash source and no `'unsafe-inline'`, `'unsafe-eval'`, `'strict-dynamic'`, nonce, host or scheme source.
3. `style-src` MUST contain exactly one hash source and nothing else.
4. No directive may allow an `http:`, `https:`, `ws:`, `wss:`, `file:` or host source.

Note: the CSP alone does not stop every network access. A `<meta http-equiv="refresh">` navigates in all engines, and `<link rel="preconnect">` opens a TCP connection in WebKit (D-03). Sanitization (§7) is therefore REQUIRED in addition to the CSP.

## 7. Content sanitization

This section constrains everything inside `<main id="aidoc-content">`. Builders MUST sanitize content to these rules. Validators MUST reject documents that break them. The model is an **allowlist**: an element or attribute not listed is forbidden.

### 7.1 Always forbidden

The following MUST NOT appear anywhere in a document except where §4 explicitly places them:

- `script` (apart from the data blocks and the runtime, §4.3), `noscript`, `template`, `slot`;
- `style` elements other than the single head `<style>`; `style` attributes on any element;
- `iframe`, `frame`, `frameset`, `object`, `embed`, `applet`, `portal`, `fencedframe`;
- `form`, `input`, `button`, `select`, `textarea`, `option`, `optgroup`, `datalist`, `output`, `fieldset`, `legend`, `label`, `dialog`;
- `base`, `link`, and every `meta` other than the four in §4.2;
- `audio`, `video`, `source`, `track`, `picture`, `canvas`, `map`, `area`;
- any attribute whose name starts with `on` (event handlers);
- `ping`, `srcset` (on any element), `formaction`, `action`, `background`, `poster`, `xmlns:*` other than the SVG and XLink namespaces, `xml:base`, `name`, `is`, `autofocus`, `contenteditable`, `popover`, `nonce`, `integrity`, `crossorigin`, `referrerpolicy`;
- in SVG: `script`, `style`, `foreignObject`, `animate`, `animateMotion`, `animateTransform`, `set`, `discard`, `a`, `feImage`;
- custom elements (names containing `-`).

### 7.2 Allowed HTML elements

`a`, `abbr`, `b`, `bdi`, `bdo`, `blockquote`, `br`, `caption`, `cite`, `code`, `col`, `colgroup`, `data`, `dd`, `del`, `details`, `dfn`, `div`, `dl`, `dt`, `em`, `figcaption`, `figure`, `h1`–`h6`, `hr`, `i`, `img`, `ins`, `kbd`, `li`, `mark`, `ol`, `p`, `pre`, `q`, `rp`, `rt`, `ruby`, `s`, `samp`, `section`, `small`, `span`, `strong`, `sub`, `summary`, `sup`, `table`, `tbody`, `td`, `tfoot`, `th`, `thead`, `time`, `tr`, `u`, `ul`, `var`, `wbr`.

MathML Core elements (`math`, `mi`, `mn`, `mo`, `ms`, `mtext`, `mspace`, `mrow`, `mfrac`, `msqrt`, `mroot`, `mstyle`, `merror`, `mpadded`, `mphantom`, `msub`, `msup`, `msubsup`, `munder`, `mover`, `munderover`, `mmultiscripts`, `mprescripts`, `mtable`, `mtr`, `mtd`, `semantics`, `annotation`) are allowed, with only the global attributes plus `display`, `mathvariant`, `displaystyle`, `scriptlevel`, `form`, `fence`, `separator`, `stretchy`, `symmetric`, `largeop`, `movablelimits`, `lspace`, `rspace`, `minsize`, `maxsize`, `accent`, `accentunder`, `linethickness`, `width`, `height`, `depth`, `voffset`, `encoding` (on `annotation`, whose content MUST be text only). MathML `href` is forbidden.

### 7.3 Allowed HTML attributes

**Global (any allowed HTML or SVG element):** `id`, `class`, `title`, `lang`, `dir`, `role`, `hidden`, `translate`, `aria-*`, and the aidoc attributes `data-aidoc-id`, `data-aidoc-type`, `data-aidoc-b` where §4 places them. Other `data-*` attributes MUST NOT appear.

**Per element:**

| Element | Attributes |
|---|---|
| `a` | `href`, `rel`, `target`, `hreflang`, `type` |
| `img` | `src`, `alt`, `width`, `height`, `decoding`, `loading` |
| `ol` | `start`, `reversed`, `type` |
| `li` | `value` |
| `td`, `th` | `colspan`, `rowspan`, `headers`; `th` also `scope`, `abbr` |
| `col`, `colgroup` | `span` |
| `time` | `datetime` |
| `data` | `value` |
| `details` | `open` |
| `abbr`, `dfn` | (global only) |
| `bdo` | `dir` (required by HTML) |

### 7.4 URLs

1. **Links.** `a[href]` MUST be either a same-document fragment (`#…` that refers to an `id` in the document) or an absolute URL with scheme `http`, `https` or `mailto` (ASCII case-insensitive, after the HTML URL parser has stripped leading/trailing C0 controls and spaces and removed tabs/newlines). Every non-fragment link MUST carry `rel="noopener noreferrer"` (the two tokens, in any order, possibly with `nofollow` or `external`). `target`, if present, MUST be `_blank`.
2. **Images.** `img[src]` MUST be a `data:` URL whose media type is one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `image/svg+xml`, with base64 encoding. Any other image source MUST be removed. (SVG loaded through `<img>` cannot run script or load resources.)
3. **Everything else.** Any other attribute that takes a URL (`cite`, `longdesc`, `usemap`, `codebase`, `data`, `manifest`, `xlink:href` and `href` outside §7.5, …) MUST be removed. `javascript:`, `vbscript:` and `file:` URLs MUST NOT appear in any attribute.

### 7.5 SVG

Inline `<svg>` is allowed for diagrams.

**Allowed SVG elements:** `svg`, `g`, `defs`, `title`, `desc`, `symbol`, `use`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`, `tspan`, `textPath`, `image`, `marker`, `linearGradient`, `radialGradient`, `stop`, `pattern`, `clipPath`, `mask`, `filter`, `feBlend`, `feColorMatrix`, `feComposite`, `feDropShadow`, `feFlood`, `feGaussianBlur`, `feMerge`, `feMergeNode`, `feMorphology`, `feOffset`.

**Allowed SVG attributes:** the global attributes of §7.3; geometry and layout (`x`, `y`, `x1`, `y1`, `x2`, `y2`, `cx`, `cy`, `r`, `rx`, `ry`, `width`, `height`, `d`, `points`, `pathLength`, `viewBox`, `preserveAspectRatio`, `transform`, `dx`, `dy`, `rotate`, `textLength`, `lengthAdjust`, `startOffset`, `xmlns`, `xmlns:xlink`, `version`); presentation attributes (`fill`, `fill-opacity`, `fill-rule`, `stroke`, `stroke-width`, `stroke-opacity`, `stroke-linecap`, `stroke-linejoin`, `stroke-miterlimit`, `stroke-dasharray`, `stroke-dashoffset`, `opacity`, `color`, `display`, `visibility`, `font-family`, `font-size`, `font-weight`, `font-style`, `text-anchor`, `dominant-baseline`, `alignment-baseline`, `baseline-shift`, `letter-spacing`, `word-spacing`, `text-decoration`, `clip-path`, `clip-rule`, `mask`, `filter`, `marker-start`, `marker-mid`, `marker-end`, `stop-color`, `stop-opacity`, `flood-color`, `flood-opacity`, `vector-effect`, `paint-order`, `shape-rendering`, `overflow`); structural (`offset`, `gradientUnits`, `gradientTransform`, `spreadMethod`, `fx`, `fy`, `fr`, `patternUnits`, `patternContentUnits`, `patternTransform`, `clipPathUnits`, `maskUnits`, `maskContentUnits`, `markerWidth`, `markerHeight`, `markerUnits`, `refX`, `refY`, `orient`, `filterUnits`, `primitiveUnits`, `in`, `in2`, `result`, `mode`, `operator`, `k1`, `k2`, `k3`, `k4`, `values`, `type`, `stdDeviation`, `edgeMode`, `radius`).

Constraints:

1. `href` and `xlink:href` are allowed only on `use` and `textPath`, where they MUST be a same-document fragment (`#id`), and on `image`, where they MUST be a `data:` image URL as in §7.4.
2. Paint and reference values (`fill`, `stroke`, `clip-path`, `mask`, `filter`, `marker-*`) MAY use `url(#id)` with a same-document fragment only.
3. Since `style` attributes and SVG `<style>` are forbidden, SVG styling MUST use presentation attributes or classes defined in the head stylesheet.

### 7.6 Other rules

1. Comments, processing instructions and CDATA sections MUST NOT appear in the document outside the runtime script text. (They have no purpose in a built file and can hide content from reviewers.)
2. Element `id` values in content MUST match `^[A-Za-z][A-Za-z0-9_-]*$` and MUST NOT start with `aidoc-` (reserved for the runtime and data blocks). This, together with forbidding `name`, limits DOM clobbering; the runtime additionally MUST NOT look up elements through named properties of `window` or `document`.
3. Builders SHOULD normalize content HTML by parsing and re-serializing it with an HTML5 parser, so that what validators see equals what browsers see.

## 8. Data blocks

### 8.1 General rules

1. Each data block is a `<script>` element in `<body>` between `</main>` and the runtime, with a `type` and an `id` from the table below. Browsers treat `<script>` with an unknown `type` as an inert data block: they never execute it. Each id MUST appear at most once.
2. **Attributes.** A data block MUST have `type` and `id`. It MAY have `data-encoding` (`json` or `base64`; default `json`), `data-compression` (`none` or `gzip`; default `none`) and `data-sha256`. Binary blocks have additional attributes (§12, §13). No other attributes are allowed.
3. **Encoding.** With `data-encoding="json"` (or absent), the stored text is the JSON text itself, and `data-compression` MUST be `none`. With `data-encoding="base64"`, the stored text is standard base64 (RFC 4648 §4, no line breaks, no whitespace) of the payload, which is gzip-compressed (RFC 1952) when `data-compression="gzip"`. For JSON blocks, the decoded payload is UTF-8 JSON.
4. **Escaping.** The stored text MUST NOT contain the character `<`. JSON serializers MUST therefore write `<` inside strings as the escape `\u003c`. (This prevents `</script>` and `<!--` from ending or altering the block.) Base64 text never contains `<`.
5. **Integrity.** For every data block other than the manifest, `manifest.blocks[<name>]` MUST be present, where `<name>` is the block name in the table. `sha256` is `sha256-b64` of the UTF-8 bytes of the stored text; `bytes` is the length of those bytes; `encoding` and `compression` MUST equal the element's effective `data-encoding` and `data-compression`. If `data-sha256` is present, it MUST equal `manifest.blocks[<name>].sha256`.
6. **Parsing.** JSON blocks MUST be valid JSON (RFC 8259) whose decoded value validates against the block's schema, with nesting depth at most 32.
7. **Order.** The manifest MUST be the first data block. The other blocks SHOULD appear in the order of the table.

### 8.2 Registered blocks

| Name | Element `id` | MIME type (`type`) | Required | Allowed encodings | Schema |
|---|---|---|---|---|---|
| (manifest) | `aidoc-manifest` | `application/aidoc-manifest+json` | yes | json only | `manifest.json` |
| `chunks` | `aidoc-chunks` | `application/aidoc-chunks+json` | yes | json; base64+gzip | `chunks.json` |
| `bm25` | `aidoc-bm25` | `application/aidoc-bm25+json` | no | json; base64+gzip | `bm25.json` |
| `vectors` | `aidoc-vectors` | `application/aidoc-vectors` | yes | base64 (+gzip or none) | binary, §12 |
| `embedder` | `aidoc-embedder` | `application/aidoc-embedder` | yes | base64 (+gzip or none) | binary, §13; header `embedder-header.json` |
| `generated` | `aidoc-generated` | `application/aidoc-generated+json` | no | json; base64+gzip | `generated.json` |
| `graph` | `aidoc-graph` | `application/aidoc-graph+json` | no | json; base64+gzip | `graph.json` |

Extension blocks (§19) use `id="aidoc-x-<name>"`, `type="application/x-aidoc-<name>"` (optionally with a `+json` suffix), and manifest key `x-<name>`.

## 9. Manifest

The manifest describes the document and indexes every other block. It MUST be stored as plain JSON (`data-encoding` absent or `json`) so that tools can read it without decompression. It MUST validate against `manifest.json`.

| Field | Type | Meaning |
|---|---|---|
| `aidoc` | `"0.1"` | Format version. |
| `title` | string | Document title. |
| `language` | BCP 47 tag | Primary language of the content. MUST equal `<html lang>`. |
| `created`, `modified?` | RFC 3339 date or date-time | Content dates. |
| `authors?` | string[] | Authors as display names. |
| `license?` | string | Licence of the *content*: an SPDX expression or free text. |
| `runtime.version` | semver | Runtime release. MUST equal the generator meta version. |
| `runtime.sha256` | base64 | MUST equal the CSP `script-src` hash. |
| `csp.profile` | `"text"` | CSP profile (§6). Only `"text"` is defined in 0.1. |
| `embedder.id` | string | Model identifier, e.g. `minishlab/potion-base-8M`. |
| `embedder.license` | string | Licence of the model weights (SPDX where possible). |
| `embedder.dims` | int | Output vector dimension. |
| `embedder.dtype` | `"int8"` | Storage type of the embedding matrix and vectors. |
| `embedder.vocabSize` | int | Number of entries in the tokenizer vocab. |
| `embedder.pca` | int \| null | Number of PCA components applied at build time, or `null`. If non-null, MUST equal `dims`. |
| `embedder.sha256` | base64 | `sha256-b64` of the **decoded, decompressed** embedder payload (§13). It identifies the model data regardless of how it is stored. |
| `privacy.offlineRequired` | `true` | Constant. Declares that the document is designed to work offline. |
| `privacy.allowCloudAI` | bool | The author's statement on whether third-party tools may send the content to cloud AI services (§18). |
| `provenance.generatedContent` | `"none"` \| `"author-reviewed"` \| `"unreviewed"` | Status of the generated content (§14). |
| `provenance.generatedBy` | string | Tool that produced the generated content (or the builder name if there is none). |
| `provenance.model?`, `provenance.generatedAt?` | string, date | Model used and when. |
| `sections[]` | `{id, title, level}` | All sections in document order (§4.4). |
| `counts` | object | `chunks` = chunk count; `faq` = FAQ entries; `quiz` = total quiz items over all sections; `nodes`, `edges` = graph sizes. Each MUST equal the actual count (0 when the block is absent). |
| `blocks` | object | Integrity entries per data block (§8.1). |
| `sizes` | object | Byte sizes, see below. |
| `thresholds.outOfScope` | number in [0,1] | In-scope score below which the reader says the document does not cover the query (§15.5). |
| `thresholds.cosRef` | number in (0,1] | Cosine at which the semantic factor of the in-scope score saturates (§15.5). |
| `thresholds.faqMatch` | number in [0,1] | Cosine threshold at or above which an FAQ entry answers a question. |

**Sizes.** All values are UTF-8 byte counts as stored in the file. `content`: the `<main>` element's outer HTML minus image data; `images`: total length of `data:` URLs in the content; `chunks`, `bm25`, `vectors`, `embedder`, `generated`, `graph`: stored text of the block (0 if absent); `runtime`, `style`: element text; `total`: the whole file. Sizes are informative: they exist so that tools can show where the bytes go. Builders SHOULD make them exact. Because `total` is part of the file it measures, builders MAY reach a fixed point by padding with spaces after the manifest JSON. Validators MUST NOT fail a document for a size mismatch, but SHOULD warn about one larger than 1%.

**Thresholds.** Builders choose thresholds for the embedder in use; values for the default embedder are set by the project's retrieval benchmark and published with each builder release.

## 10. Chunks

The chunks block is an array of chunk objects, validated by `chunks.json`:

```json
{ "id": "c0", "sectionId": "intro", "headingPath": ["Guide", "Introduction"],
  "text": "…", "blocks": ["b0", "b1", "b2"], "tokens": 212 }
```

1. `id` MUST be `"c"` followed by the chunk's 0-based index in the array. (Postings and vector rows refer to chunks by this index.)
2. `sectionId` MUST be the id of an existing section. `headingPath` MUST equal that section's heading path (§4.4).
3. `blocks` lists the `data-aidoc-b` ids of the block elements the chunk's text came from, in document order. Every listed id MUST exist in the content and belong to the chunk's section.
4. `text` is the concatenation of the blocks' text content (as the DOM `textContent`, with runs of whitespace collapsed to one space and trimmed), joined with `"\n"`. For a split block (rule 7), it is the corresponding run of sentences.
5. `tokens` is the number of WordPiece tokens (including `[UNK]`, before truncation) that the embedder tokenizer (§13.3) produces for `text`.
6. **Chunking rule.** Builders MUST chunk along block boundaries and MUST NOT let a chunk cross a section boundary. They SHOULD make chunks 150–300 tokens long. A section shorter than 150 tokens forms one chunk. Builders MUST NOT merge content of different sections to reach the target.
7. A single block longer than the target MAY be split at sentence boundaries into several chunks. Each of them lists that block's id. Splitting SHOULD use `Intl.Segmenter` sentence granularity for `manifest.language`, or an equivalent.
8. Every block element in the content SHOULD be covered by at least one chunk. Blocks with no text (for example, a figure with an empty `alt`) MAY be omitted.
9. Chunks MUST appear in document order.

**Index text.** For BM25 (§11) and for chunk vectors (§12), the text that is indexed for chunk *i* is:

```
indexText(i) = headingPath.join("\n") + "\n\n" + text
```

This lets headings match queries even in chunks that do not contain the heading element.

## 11. BM25 index

### 11.1 Block format

```json
{ "analyzer": "aidoc-word-v1", "k1": 1.2, "b": 0.75,
  "docCount": 42, "avgdl": 118.4, "docLengths": [120, 97, …],
  "postings": { "embed": [0, 3, 7, 1], "vector": [2, 1, 7, 4] } }
```

- `docCount` MUST equal the number of chunks; `docLengths[i]` is the number of analyzed terms in `indexText(i)`; `avgdl` is the sum of `docLengths` divided by `docCount`.
- `postings` maps each term to a flat list of pairs `chunkIndex, tf`, with `chunkIndex` strictly ascending and `tf ≥ 1`. The list length is even.

### 11.2 Optional block, deterministic content

The BM25 block is OPTIONAL. Readers MAY ignore it and build the index in memory from the chunks block with the analyzer below. If the block is present, its content MUST equal what the analyzer produces from the chunks: the same set of terms, the same pair lists, the same `docLengths`, and `avgdl` within a relative error of 1e-9. Key order in `postings` is not significant.

### 11.3 Analyzer `aidoc-word-v1` (normative)

Given a string *s*:

1. Normalize *s* to Unicode NFKD.
2. Remove every code point of general category Mn (nonspacing mark), i.e. `s.replace(/\p{Mn}/gu, "")`.
3. Lowercase with the locale-independent Unicode default mapping (`String.prototype.toLowerCase`).
4. Split on `/[^\p{L}\p{N}]+/u`. Drop empty tokens.
5. Drop every token that appears in the stopword list (Appendix B).
6. Apply the S-stemmer to each remaining token. A token of 3 code points or fewer is not stemmed. Otherwise, apply the first rule that matches, and only that rule:
   1. if the token ends in `ies` but not in `eies` or `aies`, replace `ies` with `y`;
   2. else, if it ends in `es` but not in `aes`, `ees` or `oes`, replace `es` with `e`;
   3. else, if it ends in `s` but not in `us` or `ss`, remove the final `s`.

   Test vectors: `queries`→`query`, `studies`→`study`, `horses`→`horse`, `embeddings`→`embedding`, `class`→`class`, `status`→`status`, `bus`→`bus`, `goes`→`goe`, `agrees`→`agree`.
7. The output is the resulting sequence of terms (duplicates kept).

Steps 5 and 6 (stopwords and stemming) are English-specific. They apply only when the primary language subtag of `manifest.language` is `en` (ASCII case-insensitive). For any other language, they are skipped and the terms are the output of step 4. Queries MUST be analyzed with the same analyzer and the same language setting as the document.

### 11.4 Scoring (informative)

Readers are expected to use Okapi BM25 with the block's `k1` and `b` and the non-negative IDF

```
idf(t) = ln(1 + (N − n_t + 0.5) / (n_t + 0.5))
score(q, i) = Σ_{t ∈ q} idf(t) · tf·(k1 + 1) / (tf + k1·(1 − b + b·dl_i / avgdl))
```

where *N* = `docCount` and *n_t* is the number of chunks containing *t*. Query terms are deduplicated.

## 12. Vectors

### 12.1 Element

```html
<script type="application/aidoc-vectors" id="aidoc-vectors"
  data-encoding="base64" data-compression="gzip" data-dtype="int8"
  data-dims="256" data-rows="57" data-sha256="…">…</script>
```

- `data-encoding` MUST be `base64`. `data-compression` MUST be `none` or `gzip`. `data-dtype` MUST be `int8`.
- `data-dims` MUST equal `manifest.embedder.dims`. `data-rows` MUST equal `counts.chunks + counts.faq`.
- `data-sha256` is REQUIRED and follows §8.1 rule 5.

### 12.2 Payload

The decoded payload is `rows × dims` signed bytes in row-major order, exactly `rows·dims` bytes long. Rows `0 … counts.chunks − 1` are chunk vectors in chunk order. Rows `counts.chunks … rows − 1` are FAQ question vectors in `faq` order.

- Chunk row *i* = `quantize(embed(indexText(i)))`.
- FAQ row *j* = `quantize(embed(faq[j].question))`. Alternate questions are not stored as rows; readers MAY embed them at load time (§15.5).

`embed` is the algorithm of §13.4. `quantize(v)` maps each component *x* of the L2-normalized float vector *v* to `clamp(round(x · 127), −127, 127)`, with round-half-away-from-zero. The value −128 MUST NOT occur.

For an L2-normalized query vector *q* (float), the reader computes the approximate cosine similarity with row *r* as `dot(q, r) / 127`.

## 13. Embedder

### 13.1 Element

```html
<script type="application/aidoc-embedder" id="aidoc-embedder"
  data-encoding="base64" data-compression="gzip" data-sha256="…">…</script>
```

`data-encoding` MUST be `base64`; `data-compression` MUST be `gzip` or `none`; `data-sha256` is REQUIRED (§8.1 rule 5, over the stored text).

### 13.2 Binary payload

All integers are little-endian.

| Offset | Size | Content |
|---|---|---|
| 0 | 4 | Magic: ASCII `AIDE` (`41 49 44 45`) |
| 4 | 4 | `headerLength`: u32, byte length of the JSON header |
| 8 | `headerLength` | UTF-8 JSON header, validated by `embedder-header.json` |
| … | 0–3 | Zero bytes padding to the next multiple of 4 from offset 0 |
| *M* | `rows × dims` | int8 matrix, row-major |
| *M* + `rows·dims` | `2 × rows` | float16 (IEEE 754 binary16) scales, one per row |

The payload MUST end immediately after the scales. Readers MUST NOT assume the scale array is 2-byte aligned (they SHOULD read it through a `DataView` or copy it). Scales MUST be finite and non-negative. The float vector of matrix row *r* is `int8row[r] × scale[r]`. Per-row scales preserve the row norms, which carry the model's frequency (Zipf) weighting.

**Header** (see schema): `format` = `"aidoc-embedder-v1"`; `model`, `license`, `dims`, `pca` MUST equal `manifest.embedder.id`, `.license`, `.dims`, `.pca`; `rows` is the matrix row count; `tokenizer.vocab` is the full vocabulary where array index = token id, and its length MUST equal `manifest.embedder.vocabSize`; vocab entries MUST be unique.

**rowMap.** If present, `rowMap` has exactly `vocab.length` entries; entry *t* is the matrix row of token id *t*, or −1 if the token has no vector. Every non-negative entry MUST be less than `rows`. If absent, the mapping is the identity and `rows` MUST equal `vocab.length`. (A `rowMap` lets builders drop vectors for tokens while keeping the full vocabulary, so that tokenization does not change.)

### 13.3 Tokenizer (normative)

The tokenizer reproduces the Hugging Face `BertNormalizer` + `BertPreTokenizer` + `WordPiece` pipeline with the header's settings.

**Normalization**, in this order:

1. *Clean text:* remove U+0000, U+FFFD and every character of general category C (Cc, Cf, Cs, Co, Cn), except that `\t`, `\n` and `\r` are kept; then replace every whitespace character (`\t`, `\n`, `\r`, and general category Zs) with U+0020.
2. *Chinese characters:* put U+0020 before and after every code point in the ranges U+4E00–9FFF, U+3400–4DBF, U+20000–2A6DF, U+2A700–2B73F, U+2B740–2B81F, U+2B820–2CEAF, U+F900–FAFF, U+2F800–2FA1F.
3. *Strip accents:* normalize to NFD, then remove every code point of general category Mn.
4. *Lowercase:* Unicode default lowercase mapping, applied to each code point on its own. There is no context-dependent mapping, so a word-final `Σ` becomes `σ`, not `ς`.

**Pre-tokenization:** split on Unicode White_Space (dropping it). Then split every punctuation character off as its own word. A punctuation character is any code point of general category P (Pc, Pd, Ps, Pe, Pi, Pf, Po) or any ASCII character in U+0021–002F, U+003A–0040, U+005B–0060, U+007B–007E.

**WordPiece**, for each word:

1. If the word is longer than `maxInputCharsPerWord` (100) code points, emit `[UNK]`.
2. Otherwise, starting at position 0, find the longest substring starting at the current position that is in the vocab (prefixed with `##` unless at position 0), emit its id and continue after it. If no substring matches at some position, discard the pieces found for this word and emit `[UNK]` once for the whole word.

Text that looks like a special token (for example the literal string `[CLS]`) gets no special treatment: it is tokenized like any other text. This deliberately differs from Hugging Face `tokenizers`, which matches added tokens in raw text. Document text therefore cannot inject special-token vectors.

### 13.4 Embedding algorithm (normative)

`embed(text)`:

1. Tokenize *text* (§13.3). Do not add special tokens.
2. Drop every `[UNK]` id and every id whose `rowMap` entry is −1.
3. Keep the first `maxTokens` (512) remaining ids.
4. If none remain, return the zero vector.
5. Otherwise, return the mean of the corresponding float row vectors (§13.2), divided by its L2 norm. (If the norm is 0, return the zero vector.)

Builders MUST use this algorithm for chunk and FAQ rows, and readers MUST use it for queries. Using one implementation for both is RECOMMENDED.

*Remark (non-normative).* This matches `model2vec`'s `StaticModel.encode` (0.9.0) for models with `normalize = true`, with one difference: model2vec first cuts the input to `512 × median_token_length` characters. aidoc does not cut by characters, so results can differ only for inputs well over 512 tokens.

## 14. Generated content and concept graph

### 14.1 Generated content

The generated block has the same shape as the authoring file `generated.json`, and both validate against `generated.json`:

```json
{ "aidoc": "0.1",
  "provenance": { "generatedBy": "aidoc-gen 0.1.0", "model": "…", "reviewed": true,
                  "reviewedBy": "A. Author", "created": "2026-10-01" },
  "sections": { "<sectionId>": {
      "summary": "…", "simpleExplanation": "…", "keyPoints": ["…"],
      "quiz": [ { "id": "q1", "question": "…", "options": ["…", "…", "…"],
                  "answerIndex": 1, "explanation": "…" } ] } },
  "faq": [ { "id": "f1", "question": "…", "alternateQuestions": ["…"],
             "answer": "…", "sourceSectionIds": ["intro"] } ] }
```

`sections` and `faq` are OPTIONAL and default to `{}` and `[]`. Text fields are plain text: readers MUST render them as text, never as HTML. A blank line in a text field separates paragraphs.

Validators MUST check, in addition to the schema:

1. every key of `sections` and every entry of `sourceSectionIds` is a section id in the manifest;
2. `answerIndex < options.length` for every quiz item;
3. quiz ids are unique across the whole document, and FAQ ids are unique;
4. option strings within one quiz item are unique;
5. consistency with the manifest: `provenance.reviewed = true` if and only if `manifest.provenance.generatedContent = "author-reviewed"`; if the block is absent or contains no summaries, explanations, key points, quiz items or FAQ entries, `generatedContent` MUST be `"none"`; `counts.faq` and `counts.quiz` match.

Builders MUST NOT mark content as reviewed (`reviewed: true`) unless a person has reviewed it; the builder SHOULD require an explicit author action to set it.

### 14.2 Concept graph

The graph block has the same shape as the authoring file `graph.json`, validated by `graph.json`:

```json
{ "nodes": [ { "id": "embedder", "label": "Static embedder", "aliases": ["model2vec"],
               "sectionId": "search", "description": "…" } ],
  "edges": [ { "from": "tokenizer", "to": "embedder", "relation": "is input to" } ] }
```

`relation` is a short verb phrase read as "*from* relation *to*" (for example `is input to`, `is part of`, `produces`, `uses`, `speeds up`).

Validators MUST check: node ids are unique; both endpoints of every edge exist; every node `sectionId` exists; no two edges have the same (`from`, `to`, `relation`). Builders SHOULD keep labels and aliases unique across nodes after analysis with `aidoc-word-v1`, since the router (§21) matches concept names through them.

## 15. Reader (runtime) conformance

### 15.1 Parsing and integrity

1. A reader MUST decode data blocks only with `JSON.parse`, base64 decoding, gzip decompression (`DecompressionStream("gzip")` or equivalent) and typed-array views. It MUST NOT use `eval`, `Function`, `import()`, string-argument timers or any other way of executing content from the document.
2. Where `crypto.subtle` is available, a reader MUST verify each block's `sha256` (§8.1) before using it. A block that fails verification MUST NOT be used. Where `crypto.subtle` is not available, the reader MAY proceed without verification and SHOULD show a discreet notice.
3. A reader MUST validate the structural facts it relies on (lengths, counts, index ranges, magic, header fields) before using a block. Full schema validation at read time is OPTIONAL.
4. A reader MUST insert document- and generated-text into the DOM only as text (`textContent`, text nodes), never via `innerHTML` or equivalent. Highlighting is done by building text nodes and elements programmatically.

### 15.2 Resource limits and failure

1. A reader MUST enforce the limits of §17 *before* allocating for or decoding a block: check the stored text length first, then the decoded length, and abort decompression as soon as output exceeds the limit (this defeats decompression bombs).
2. On any failure (limit exceeded, hash mismatch, malformed data, missing API), the reader MUST fail gracefully:
   - the document content MUST stay visible and readable;
   - the panel MUST show a short, readable message naming what is unavailable (for example: "Semantic search is unavailable because the embedding data is damaged. Keyword search still works.");
   - unaffected features SHOULD remain available. In particular, if vectors or the embedder fail, the reader SHOULD fall back to BM25-only search; if `generated` or `graph` fail, search and extractive answers SHOULD still work.
3. If the chunks block fails, the panel MUST be disabled with a message; the document stays readable.
4. A reader MUST NOT use more than one main-thread task longer than about 200 ms for loading; it SHOULD decode large blocks lazily (for example, the embedder on first query) and yield to the event loop between steps.

### 15.3 Provenance labels

1. Every piece of generated content shown to the user (summary, simple explanation, key points, quiz, FAQ answer) MUST carry the visible label **"Prepared by the author"**. If `manifest.provenance.generatedContent` is `"unreviewed"`, the label MUST instead be **"Prepared by the author (AI-generated, not reviewed)"**.
2. Every passage or sentence extracted from the chunks MUST carry the visible label **"Found in the document"**.
3. Labels MUST be visually attached to the content they describe and MUST NOT be hidden behind an interaction. Readers MAY localize the labels into the document language, keeping their meaning.

### 15.4 Citations

1. Every answer MUST cite its source sections. Extracted passages cite their chunk's section and link to its first block element. FAQ answers cite `sourceSectionIds`. Summaries, explanations and quizzes cite the section they belong to. Relation answers cite the sections of the supporting passages.
2. Activating a citation MUST scroll the content to the cited block (or the section's heading) and SHOULD highlight it briefly. Navigation MUST stay within the document.

### 15.5 Answering and out-of-scope

1. **In-scope score.** Let `bestCos` be the highest approximate cosine (§12.2) between the query vector and any chunk row. Let `coverage` be the importance-weighted share of the query's content words that occur in the document:
   - the words are `words(query)`, i.e. steps 1–4 of §11.3, minus stopwords when the stopword step applies;
   - a word *occurs* if its analyzed term (stemmed when stemming applies) is a key of the BM25 postings;
   - its weight is the largest row norm (`‖int8row‖ × scale`, §13.2) among the word's embedder tokens, excluding `[UNK]` and unmapped ids. These norms carry the model's Zipf weighting, so rare, informative words weigh more;
   - `coverage = Σ weight(found) / Σ weight(all)`, or 0 when the denominator is 0.

   The in-scope score is `coverage × min(1, max(0, bestCos) / thresholds.cosRef)`. If it is below `thresholds.outOfScope`, the reader MUST answer with exactly **"This document doesn't seem to cover that."** (or its localization), MAY add the closest search results labeled as such, and MUST NOT present any passage as an answer.

   *Rationale (informative):* with a static embedder, cosine alone cannot separate close-but-uncovered questions (for example, other machine-learning topics in a machine-learning document) from covered ones. The coverage factor checks that the question's informative words actually occur in the document. Measured in docs/decisions.md D-09.
2. If vectors are unavailable (BM25-only fallback), the in-scope score is `coverage` computed with all weights equal to 1.
3. An FAQ entry answers a question only if its cosine (over its stored row, or any alternate question embedded at load time) is at least `thresholds.faqMatch`. Readers MAY lower a variant's cosine by a fixed penalty when its question word (what, where, why, how, when, who, which) differs from the query's. They MAY also require a minimum share of query terms to occur in the entry's questions. Both guards are RECOMMENDED; see D-09.
4. Readers MUST NOT synthesize text. An answer consists only of stored generated content, verbatim extracted text, and fixed UI wording.

### 15.6 Behaviour

1. A reader MUST NOT make or attempt any network request. (The CSP blocks them; a conforming runtime does not even try. Tests assert zero request events and zero connections, D-04.)
2. A reader MUST NOT write to persistent storage (`localStorage`, `sessionStorage`, IndexedDB, cookies, Cache API). On `file://`, browsers may share one storage origin among unrelated local files.
3. A reader MAY offer downloads (for example, exporting quiz results) through `blob:` URLs and `<a download>`, only in response to a user action.
4. The panel MUST be operable by keyboard and labeled for assistive technology.

## 16. Validator conformance

A conforming validator MUST parse the file with the HTML5 parsing algorithm (not with regular expressions) and MUST report an error for each violated MUST of §§3–14 and §17. In particular it MUST:

1. check the head order, the exact CSP string for the declared profile, and both hashes against the stored element texts;
2. check `manifest.runtime.sha256` against the list of official runtime releases known to the validator (the project publishes it as `spec/runtime-hashes.json`: an array of `{version, sha256}`) and report an unofficial runtime as an error (a validator MAY offer an option to downgrade this to a warning for development builds);
3. apply the sanitization allowlist (§7) to the whole document;
4. check every data block: attributes, encoding, `<`-freeness, `bytes`, `sha256`, decode, schema validation, limits;
5. check cross-references: sections ↔ manifest, chunk sections and block ids, heading paths, counts, vector `rows`/`dims`, embedder header ↔ manifest, `embedder.sha256`, generated and graph rules (§14);
6. if a BM25 block is present, rebuild the index from the chunks and compare (§11.2);
7. re-tokenize chunk texts and check `tokens`.

A validator SHOULD recompute the vectors from the embedder and warn if any row's cosine similarity with the recomputed row is below 0.99. It SHOULD warn about chunks outside the 150–300 token target that are not explained by rule §10.6/§10.7, about uncovered blocks, and about size mismatches (§9). A validator MUST validate authoring files (`generated.json`, `graph.json`) with the same schemas and §14 rules when given a manifest or section list.

Validators MUST NOT execute the runtime or any content to decide conformance.

## 17. Resource limits

Documents MUST stay within these limits. Readers MUST enforce them (§15.2). Validators MUST reject documents that exceed them.

| Item | Limit |
|---|---|
| Total file size | 50 MB (52,428,800 bytes) |
| Stored text of any single data block | 20 MB |
| Decoded (decompressed) size of any JSON block | 20 MB |
| Decoded embedder payload | 48 MB |
| Embedder JSON header | 4 MB |
| Decoded vectors payload | exactly `rows × dims` bytes (also bounded by the 20 MB stored-text limit) |
| JSON nesting depth | 32 |
| Sections | 5,000 |
| Heading level | 1–6 |
| Chunks | 20,000 |
| Characters per chunk `text` | 10,000 |
| Block ids per chunk | 1,000 |
| Embedding dimensions (`dims`) | 1,024 |
| Vocabulary size | 100,000 |
| Vocab entry length | 200 characters |
| BM25 distinct terms | 500,000 |
| BM25 term length | 100 characters |
| FAQ entries | 2,000 |
| Alternate questions per FAQ entry | 20 |
| Quiz items per section | 100 |
| Quiz items per document | 2,000 |
| Options per quiz item | 2–6 |
| Key points per section | 20 |
| Summary / simple explanation | 10,000 characters each |
| FAQ answer, quiz explanation | 5,000 characters |
| Question text | 1,000 characters |
| Graph nodes / edges | 5,000 / 20,000 |
| Aliases per node | 20 |
| Data URL images | 10 MB each |
| Query length accepted by a reader | 1,000 characters (longer input is truncated) |

Note: the vectors block rows are bounded by `chunks + faq` ≤ 22,000. Builders SHOULD stay well under these limits; a document of typical length is a few MB plus the embedder (about 4.8–9 MB in-file for the default model, see D-01).

## 18. Security considerations

**Threat model.** A document may come from an untrusted source. Opening it MUST NOT run any code other than the official runtime, MUST NOT contact the network, and MUST NOT read other local files. aidoc relies on four layers:

1. **CSP** (§6): only the hash-pinned runtime and stylesheet apply; network, frames, workers, forms and plugins are blocked. Measured in Chromium, Firefox and WebKit from `file://` (D-02).
2. **Sanitization** (§7): removes markup that bypasses the CSP (`meta refresh` navigation, `link rel=preconnect` in WebKit, D-03) and everything that would be blocked anyway, so that what a reviewer sees is what runs.
3. **Inert data**: data blocks are never executed; the runtime parses them with `JSON.parse` and typed arrays only, and inserts text only as text.
4. **Limits** (§17): bound memory and CPU, including for decompression.

**Official runtime.** A file's CSP permits exactly the runtime it contains. An attacker can ship a file with a different script and a matching hash: the CSP then permits that script. Hash-pinning protects against injected content, not against a malicious author. Users and tools SHOULD check that `runtime.sha256` is an official release (validators do this, §16; a browser extension could too). This is the main reason the format names one official runtime.

**Integrity is not authenticity.** Block hashes detect corruption and inconsistent edits, not deliberate tampering.

**Links.** External links are allowed (http, https, mailto) and navigate away from the document only when the user activates them. `rel="noopener noreferrer"` prevents the destination from obtaining a reference to the document window and from receiving a `Referer`. Readers SHOULD visually mark external links.

**Local file access.** Browsers block `file://` reads from a `file://` page under default settings. Firefox with `security.fileuri.strict_origin_policy=false` (a non-default, user-changed setting) allows them despite `connect-src 'none'`; the runtime never attempts such reads, and content cannot run script, so this setting does not expose data through a conforming document. Such configurations are outside the threat model.

**Misleading content.** Generated content may be wrong. The provenance labels (§15.3) and the out-of-scope message (§15.5) exist so that readers can judge it. A malicious author can, of course, write misleading content; aidoc does not judge content.

**Parser differentials.** Validators and builders MUST use an HTML5-conformant parser; mXSS-style differences are avoided by re-serializing content (§7.6) and by forbidding comments, `template`, `noscript` and foreign-content tricks such as `foreignObject` and MathML `annotation-xml`.

## 19. Privacy considerations

- A conforming document cannot send data anywhere: queries, quiz answers and reading behaviour stay in the browser tab and are discarded when it closes (§15.6).
- The runtime keeps no persistent state, so opening one document reveals nothing to another.
- `privacy.allowCloudAI` records the author's wish about whether third-party tools (for example, a browser extension or an AI assistant that reads the file) may send the content to a cloud AI service. It is a declaration, not an enforcement mechanism; the document itself never contacts any service. Such tools SHOULD respect `false`.
- The manifest may contain personal data (author names). Builders SHOULD let authors omit `authors` and `reviewedBy`.
- Build-time AI generation may send the content to an AI provider. That happens outside the file and is the builder's responsibility to disclose; `provenance.model` records which model was used.

## 20. Versioning and extensibility

1. **Format version.** `manifest.aidoc` is `MAJOR.MINOR`. This document defines `0.1`.
   - A reader MUST refuse to interpret data blocks of a document with a different MAJOR (the content stays readable as HTML).
   - Within the same MAJOR, a reader SHOULD process documents with a higher MINOR, ignoring what it does not understand. While MAJOR is 0, a MINOR change MAY be incompatible; such a change will be listed in the new version's changelog, and the embedded runtime always matches its own document.
   - A validator validates against the version the document declares and MUST report a version it does not implement.
2. **Runtime version.** `runtime.version` is a semantic version. Its MAJOR.MINOR equals the format version it implements; PATCH releases fix bugs without changing the format.
3. **Unknown fields.** Readers MUST ignore unknown members in every JSON object. Validators of version 0.1 MUST reject unknown members unless their name starts with `x-` (the schemas enforce this).
4. **Extensions.** Extension fields MUST be named `x-<name>`, where `<name>` is lowercase ASCII letters, digits and hyphens, and SHOULD include an organization prefix (for example `x-acme-reviewlog`). Extension blocks follow §8.2. Extensions MUST NOT change the meaning of standard fields, MUST NOT require script execution beyond the official runtime, and MUST respect §17 (they count towards the file size).
5. **Analyzer and embedder formats** are versioned by name (`aidoc-word-v1`, `aidoc-embedder-v1`). A new analyzer or binary format gets a new name; the old name keeps its meaning forever.
6. **Breaking changes** (new required fields, changed semantics, a looser CSP) require a MAJOR version bump once the format reaches 1.0.

## 21. Router intents (informative)

The runtime classifies each query with simple rules (keyword patterns, concept-name matching through graph labels and aliases) before retrieval. There is no model in this step.

| Intent | Example triggers | Result |
|---|---|---|
| `find` | "where does it discuss X", "find X", "search X" | Ranked search results (fused retrieval), each "Found in the document". |
| `summarize` | "summarize", "summary of X", "tl;dr" | `summary` (and `keyPoints`) of the target section, "Prepared by the author". |
| `explain-simply` | "ELI5", "explain simply", "in plain words" | `simpleExplanation` of the target section. |
| `quiz` | "quiz me", "test me on X" | Quiz UI with the target section's items (or items from sections matching X). |
| `relation` | "how does X relate to Y", "X vs Y" | Shortest path between the nodes for X and Y in the concept graph (edges traversed in either direction, shown with their direction), plus supporting passages from the sections of the path's nodes. |
| `question` (default) | anything else | See below. |

**Target section.** "this section", or no explicit target, means the section currently in view (the section whose heading was most recently scrolled past the top of the viewport). An explicit target ("summarize the installation section") is resolved by matching section titles and graph aliases. If the target has no generated content of the requested kind, the router falls back to `question`.

**Question pipeline.**

1. FAQ: if the best FAQ cosine ≥ `thresholds.faqMatch`, show that FAQ answer with its citations.
2. Otherwise, retrieve: rank chunks by BM25 and by cosine, take the top 50 of each, and fuse with reciprocal rank fusion, `score(c) = Σ 1 / (60 + rank(c))` over the lists in which *c* appears (ranks start at 1).
3. Out of scope: if `bestCos < thresholds.outOfScope`, show "This document doesn't seem to cover that." (§15.5).
4. Otherwise, extract an answer: split the top 3 fused chunks into sentences (`Intl.Segmenter`), score each sentence by query-term overlap and by the cosine of its embedding with the query, and show the 1–3 best sentences in document order, "Found in the document", each citing its section.

## Appendix A. Example minimal document (informative)

Hashes and base64 payloads are abbreviated with `…`. Real files contain the full values.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-Rt…='; style-src 'sha256-9k…='; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="aidoc 0.1.0">
<title>Tea Basics</title>
<style>body{font-family:system-ui,sans-serif;max-width:42rem;margin:auto}</style>
</head>
<body>
<main id="aidoc-content">
<section data-aidoc-id="brewing" data-aidoc-type="section">
<h1 data-aidoc-b="b0">Brewing</h1>
<p data-aidoc-b="b1">Green tea brews best at 75–80 °C for two minutes. Boiling water makes it bitter.</p>
<p data-aidoc-b="b2">Black tea needs boiling water and three to five minutes. See <a href="https://example.org/tea" rel="noopener noreferrer">this guide</a>.</p>
</section>
</main>
<script type="application/aidoc-manifest+json" id="aidoc-manifest">{"aidoc":"0.1","title":"Tea Basics","language":"en","created":"2026-10-08","license":"CC-BY-4.0",
"runtime":{"version":"0.1.0","sha256":"Rt…="},"csp":{"profile":"text"},
"embedder":{"id":"minishlab/potion-base-8M","license":"MIT","dims":128,"dtype":"int8","vocabSize":29528,"pca":128,"sha256":"Qm…="},
"privacy":{"offlineRequired":true,"allowCloudAI":false},
"provenance":{"generatedContent":"author-reviewed","generatedBy":"aidoc-gen 0.1.0","model":"example-model"},
"sections":[{"id":"brewing","title":"Brewing","level":1}],
"counts":{"chunks":1,"faq":1,"quiz":1,"nodes":2,"edges":1},
"blocks":{"chunks":{"sha256":"c1…=","bytes":231,"encoding":"json","compression":"none"},
 "vectors":{"sha256":"v1…=","bytes":344,"encoding":"base64","compression":"none"},
 "embedder":{"sha256":"e1…=","bytes":4980000,"encoding":"base64","compression":"gzip"},
 "generated":{"sha256":"g1…=","bytes":702,"encoding":"json","compression":"none"},
 "graph":{"sha256":"k1…=","bytes":160,"encoding":"json","compression":"none"}},
"sizes":{"content":420,"images":0,"chunks":231,"bm25":0,"vectors":344,"embedder":4980000,"generated":702,"graph":160,"runtime":61000,"style":75,"total":5045000},
"thresholds":{"outOfScope":0.3,"faqMatch":0.8}}</script>
<script type="application/aidoc-chunks+json" id="aidoc-chunks">[{"id":"c0","sectionId":"brewing","headingPath":["Brewing"],"text":"Brewing\nGreen tea brews best at 75–80 °C for two minutes. Boiling water makes it bitter.\nBlack tea needs boiling water and three to five minutes. See this guide.","blocks":["b0","b1","b2"],"tokens":38}]</script>
<script type="application/aidoc-vectors" id="aidoc-vectors" data-encoding="base64" data-compression="none" data-dtype="int8" data-dims="128" data-rows="2" data-sha256="v1…=">AfQ…</script>
<script type="application/aidoc-embedder" id="aidoc-embedder" data-encoding="base64" data-compression="gzip" data-sha256="e1…=">H4sI…</script>
<script type="application/aidoc-generated+json" id="aidoc-generated">{"aidoc":"0.1","provenance":{"generatedBy":"aidoc-gen 0.1.0","model":"example-model","reviewed":true,"created":"2026-10-08"},
"sections":{"brewing":{"summary":"Green tea: 75–80 °C, two minutes. Black tea: boiling water, three to five minutes.",
"quiz":[{"id":"q1","question":"What water temperature suits green tea?","options":["100 °C","75–80 °C","50 °C"],"answerIndex":1,"explanation":"Boiling water makes green tea bitter."}]}},
"faq":[{"id":"f1","question":"How long should I steep black tea?","answer":"Three to five minutes, in boiling water.","sourceSectionIds":["brewing"]}]}</script>
<script type="application/aidoc-graph+json" id="aidoc-graph">{"nodes":[{"id":"green-tea","label":"Green tea","sectionId":"brewing"},{"id":"water-temperature","label":"Water temperature","aliases":["temperature"],"sectionId":"brewing"}],
"edges":[{"from":"water-temperature","to":"green-tea","relation":"affects the taste of"}]}</script>
<script>/* official aidoc runtime 0.1.0 */…</script>
</body>
</html>
```

## Appendix B. Stopword list for `aidoc-word-v1` (normative)

The list contains exactly these 126 lowercase entries (tokens are compared after steps 1–4 of §11.3):

```
a about above after again against all am an and any are as at
be because been before being below between both but by
can could did do does doing down during each few for from further
had has have having he her here hers herself him himself his how
i if in into is it its itself just me more most my myself
no nor not now of off on once only or other our ours ourselves out over own
same she should so some such than that the their theirs them themselves then
there these they this those through to too under until up very
was we were what when where which while who whom why will with would
you your yours yourself yourselves
```

Note: `s`, `t`, `don`, and other contraction fragments are not in the list; contractions such as `don't` split into `don` and `t`, which are kept. Because steps 1–4 lowercase and strip accents first, the list applies case- and accent-insensitively.

## Appendix C. References

- [RFC 2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119.
- [RFC 8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174.
- [RFC 3339] Date and Time on the Internet: Timestamps. [RFC 4648] Base16, Base32, and Base64 Data Encodings. [RFC 1952] GZIP file format. [RFC 8259] JSON. [BCP 47] Tags for Identifying Languages.
- W3C, Content Security Policy Level 3. WHATWG, HTML Living Standard. W3C, MathML Core.
- Harman, D. (1991), "How effective is suffixing?", JASIS 42(1).
- Robertson, S., Zaragoza, H. (2009), "The Probabilistic Relevance Framework: BM25 and Beyond".
- Cormack, G., Clarke, C., Büttcher, S. (2009), "Reciprocal rank fusion outperforms Condorcet and individual rank learning methods".
- model2vec (MinishLab), `StaticModel`, version 0.9.0. Hugging Face `tokenizers` `BertNormalizer`, `BertPreTokenizer`, `WordPiece`.
- aidoc project, `docs/decisions.md` (D-01 to D-05).
