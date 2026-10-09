# Decisions log

Each entry: what we decided, why, and the evidence. Numbers are measured unless marked otherwise.
Phase 0 measurements were taken on 2026-10-08 (macOS 15, Node 24.3, Playwright 1.64.0).

---

## D-01 Static embedder: `minishlab/potion-base-8M` (MIT)

| Model | Licence | Vocab | Dims | float32 size |
|---|---|---|---|---|
| `minishlab/potion-base-8M` (default candidate) | MIT | 29,528 | 256 | 30.2 MB |
| `minishlab/potion-retrieval-32M` (alternative) | MIT | 63,091 | 512 | 129.2 MB |
| `minishlab/potion-base-4M` (smaller fallback) | MIT | n/a | n/a | n/a |

Licences come from the Hugging Face model cards (`license: mit`). `model2vec` (the reference library) is also MIT.

**Tokenizer (confirmed from `tokenizer.json`):** BERT-style **WordPiece**, uncased.
- Normalizer: `BertNormalizer {clean_text, handle_chinese_chars, lowercase: true, strip_accents: null}`.
  `strip_accents: null` follows `lowercase`, so **accents are stripped** (`Café naïve` → `cafe naive`). The TS tokenizer must do NFD and remove combining marks.
- Pre-tokenizer: `BertPreTokenizer` (split on whitespace and on every punctuation char). CJK characters become single tokens.
- WordPiece: `##` continuation prefix, `max_input_chars_per_word: 100`, unknown → `[UNK]`.
- The vocab is pruned from bge-base-en-v1.5 (29,528 entries rather than 30,522). The retrieval-32M vocab adds about 33k whole-word tokens.

**Embedding method (read from the model2vec 0.9.0 source, `StaticModel.tokenize` / `_encode_batch`):**
1. Encode with `add_special_tokens=False`, so there is no `[CLS]` or `[SEP]`.
2. Drop every `[UNK]` id.
3. Truncate to `max_length=512` tokens. Before tokenizing, text is also cut to `512 × median_token_length` characters.
4. Mean of the token rows. If no tokens remain, return a zero vector.
5. L2-normalize (`x / (‖x‖ + 1e-32)`), because `config.normalize = true`.

Zipf weighting is already **baked into the row norms** (`apply_zipf: true`; row norms range from 0.5 to 130). Quantization must therefore keep each row's scale, otherwise mean pooling loses its weighting. Plan: per-row symmetric int8 plus a float16 scale per row.

We use **one TS tokenizer at both build time and read time**, so query and document vectors always match. A parity test against HF `tokenizers` on about 500 strings is planned for Phase 2.

**Size options (measured; int8 + per-row f16 scales, then gzip -9, then base64 as embedded in HTML):**

| Variant | Raw int8 | gzip | In-file (base64 of gzip) |
|---|---|---|---|
| potion-base-8M, 256 d | 7.62 MB | 6.74 MB | **8.98 MB** |
| potion-base-8M, PCA 128 d | 3.84 MB | 3.56 MB | **4.75 MB** |
| potion-retrieval-32M, PCA 256 d | 16.28 MB | 14.89 MB | 19.85 MB |
| potion-retrieval-32M, PCA 128 d | 8.20 MB | 7.69 MB | 10.25 MB |

Vocab text adds about 108 KB (8M) or 245 KB (32M) after gzip. int8 data barely compresses (about 12%), so most of the cost is base64's 33%. Choosing the default variant (including a vocab subset) waits for the retrieval benchmark in Phase 2/4. **Status: open.**

---

## D-02 CSP: what works from `file://` (all three engines)

Test suite: `tests/platform/file-protocol.spec.ts` (`pnpm test:platform`). **12/12 pass** on Chromium, Firefox and WebKit.
Network oracle: a local TCP server counts every connection attempt. **Result: 0 connections from all script-based probes.**

| Probe | Chromium | Firefox | WebKit |
|---|---|---|---|
| Hash-pinned inline runtime script runs | ✅ | ✅ | ✅ |
| Unhashed inline `<script>` blocked | ✅ | ✅ | ✅ |
| Inline event handler (`onerror=`) blocked | ✅ | ✅ | ✅ |
| Inert data block (`type="application/…+json"`) readable, never executed | ✅ | ✅ | ✅ |
| Hash-pinned `<style>` applied / unhashed `<style>` blocked | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ |
| `style="…"` attributes | **blocked** | **blocked** | **blocked** |
| SVG presentation attributes (`fill=`) | work | work | work |
| CSSOM (`el.style.setProperty`) from the runtime | works | works | works |
| `data:` images | load | load | load |
| fetch / XHR / WebSocket / EventSource / sendBeacon / `<img>` / dynamic import / Worker / iframe / CSS `url()` to http | all blocked | all blocked | all blocked |
| fetch/XHR of sibling, parent or absolute `file://` paths | blocked | blocked* | blocked |
| WASM with `'wasm-unsafe-eval'` | works | works | works |
| WASM without it | blocked | blocked | blocked |
| Blob worker with `worker-src blob:` (CSP inherited: fetch inside the worker is blocked) | works | works | works |
| Blob worker without `worker-src blob:` | blocked | blocked | blocked |
| `DecompressionStream('gzip')` | works | works | works |
| `crypto.subtle` (`isSecureContext` is true on file://) | works | works | works |
| Download via `blob:` URL + `<a download>` | works | works | works |

\* **Test-harness pitfall:** Playwright's Firefox sets `security.fileuri.strict_origin_policy=false`. With it, a `file://` page can read `/etc/hosts` and list directories despite `connect-src 'none'`. Real Firefox defaults to `true`. Our Playwright config restores `true`; with that, reads are blocked. Users who changed that pref themselves are outside our threat model (see security.md).

**Decision: the CSP for text documents is tighter than the draft:**

```
default-src 'none'; script-src 'sha256-<runtime>'; style-src 'sha256-<style>';
img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'
```

- **Removed `'wasm-unsafe-eval'` and `worker-src blob:`.** The text runtime is plain TS on the main thread and needs neither. Both are added **only in PDF mode** (Phase 3), and only if pdf.js needs them (pdf.js uses WASM for some image decoders; to verify). If they are added, the CSP still inherits into workers, so network stays blocked.
- **Removed `font-src data:`.** We use system fonts.
- **Removed `blob:` from `img-src`.** Not needed for text documents; it returns in PDF mode only if required.
- `frame-ancestors`, `sandbox` and `report-uri` are ignored in a `<meta>` CSP, so they are not used.
- The meta CSP must be the first element in `<head>` after `<meta charset>`.
- All CSS (runtime + document) goes into **one** `<style>` block, pinned by its hash.

## D-03 Markup that reaches the network *despite* the CSP → the sanitizer must strip it

Static markup with no script, measured by TCP connections:

| Markup | Chromium | Firefox | WebKit |
|---|---|---|---|
| `<meta http-equiv="refresh" content="0;url=http://…">` | **navigates** | **navigates** | **navigates** |
| `<link rel="preconnect" href="http://…">` | 0 | 0 | **opens TCP** |
| prefetch, preload, stylesheet, icon, img, srcset, picture, video poster, audio, iframe, object, embed, svg image/use, input image, style-attr background, `<form>`, `<a ping>` (incl. clicked) | 0 | 0 | 0 |

So the CSP alone is not enough. The build-time sanitizer **removes all `<link>`, `<base>`, and every `<meta>` except** `charset`, `viewport`, our CSP and `generator`. The validator rejects them too. It also strips `style` attributes (the CSP would silently drop them anyway), so SVG diagrams must use presentation attributes or classes in the main stylesheet.

## D-04 Network assertion in the browser tests

In Chromium, Playwright fires `request` events for attempts that the CSP then blocks (we saw 5 events with 0 TCP connections). The Phase 2 tests therefore assert both:
1. **zero `request` events** apart from the document itself, which means our runtime never even tries, and
2. **zero TCP connections** to the canary server.

## D-05 Runtime capabilities we can rely on

`DecompressionStream('gzip')` works everywhere from `file://`, so large data blocks (vectors, embedder) may be stored gzipped. `crypto.subtle` works, so the runtime can verify data block hashes on load. Both will be used, behind measurement.

---

## Dependency licences

| Package | Version checked | Licence | Use |
|---|---|---|---|
| `@playwright/test` | 1.64.0 | Apache-2.0 | browser tests (dev) |
| `typescript` | 7.0.2 | Apache-2.0 | build (dev) |
| `esbuild` | 0.28.2 | MIT | bundling (dev) |
| `vitest` | 5.0.3 | MIT | unit tests (dev) |
| `ajv` | 8.20.0 | MIT | JSON Schema validation (core) |
| `unified` / `remark-parse` | 11.0.5 / 11.0.0 | MIT | Markdown parsing (core) |
| `mammoth` | 1.13.0 | BSD-2-Clause | DOCX import (Phase 3) |
| `pdfjs-dist` | 6.4.299 | Apache-2.0 | PDF text extraction + inline rendering (Phase 3) |
| `pdf-lib` | 1.17.1 | MIT | PDF utilities (Phase 3, only if needed) |
| `model2vec` (Python, reference only) | 0.9.0 | MIT | parity tests and benchmarks; not shipped |
| `tokenizers` (Python, reference only) | 0.23.2 | Apache-2.0 | tokenizer parity tests; not shipped |
| potion-base-8M weights | n/a | MIT | shipped inside documents |

Only `@playwright/test` is installed so far. The others are added in the phase that needs them, and this table is re-checked then.

---

## D-06 Phase 1: example source format

`examples/transformer/` holds three files:
- `document.md`: Markdown with YAML front matter. Section ids are written as `## Heading {#id}`, and diagrams are inline SVG that use presentation attributes only (D-02).
- `generated.json`
- `graph.json`

The source files use the same schemas as the packaged blocks (`spec/schemas/generated.schema.json`, `graph.schema.json`), so content made by another tool can be dropped in as is. Quiz answer positions were shuffled deterministically, because the first draft put 31 of 45 correct answers in position 1.

## D-07 Spec choices made while drafting (review at Checkpoint 1)

These are recorded in `spec/aidoc-0.1.md`:
- Block hashes cover the stored text, so they can be checked before decoding. The embedder hash covers the decoded payload, so it identifies the model however it is stored.
- Data blocks must not contain `<`; JSON writes it as `\u003c`.
- Required blocks: manifest, chunks, vectors, embedder. Optional: bm25 (can be rebuilt from chunks), generated, graph.
- BM25 and chunk vectors both index `headingPath + text`. FAQ rows embed `question` only.
- Out-of-scope rule: best chunk cosine below `thresholds.outOfScope`. The threshold is calibrated in Phase 2.
- The reader uses no persistent storage, because `file://` pages may share a storage origin.
- Readers must not write their own text: an answer is only stored generated content, verbatim extracted text and fixed UI wording.

## D-08 Tokenizer parity (measured)

The TS tokenizer (`packages/core/src/text/tokenizer.ts`) matches HF `tokenizers` 0.23.2 on **499/499** fixture strings. The fixture holds 500 strings: edge cases, multilingual text, emoji, control characters and document sentences. The one excluded string is a deliberate divergence: literal `[CLS]`/`[MASK]` text is not treated as a special token (spec §13.3), so content cannot inject special-token vectors.

Finding: HF lowercases each code point separately, so JS `toLowerCase()` on a whole string is wrong for word-final `Σ`. Fixed, and the rule is written into the spec.

Float embeddings match model2vec 0.9.0 with cosine > 0.99999 on 80 strings. int8 + f16-scale quantization of the embedder keeps cosine > 0.995. Fixtures come from `scripts/gen-parity-fixtures.py`.

## D-09 Default embedder, thresholds and the out-of-scope rule (Phase 2, measured)

Eval set: `benchmarks/eval/transformer.json`. It has 46 in-scope questions, phrased independently of the FAQ, and 25 out-of-scope ones: 15 far off-topic and 10 near-domain ML topics the document doesn't cover. Run with `pnpm calibrate`.

| Embedder variant | In-file size | Hybrid hit@1 | Hybrid hit@3 | BM25 hit@1/@3 | Cosine hit@1/@3 |
|---|---|---|---|---|---|
| potion-base-8M, 256 d | 9.13 MB | 39/46 | 42/46 | 39/43 | 39/42 |
| **potion-base-8M, PCA 128 d (default)** | **4.90 MB** | **40/46** | **44/46** | 40/44 | 36/41 |

**Default: PCA to 128 dims.** It retrieves as well as 256 dims at half the size; hybrid fusion hides the small loss in cosine-only quality. The PCA is uncentered (eigenvectors of EᵀE), so the shared mean direction and the Zipf row norms survive. A vocab-subset variant was not needed at this size; it is revisited in Phase 4.

**Out-of-scope: cosine alone does not work with a static embedder.** Near-domain questions such as "What is a support vector machine?" score 0.40–0.64, above some real in-scope questions (lowest 0.23). The best cosine-only threshold (0.3) keeps 45/46 in-scope questions but rejects only 11/15 far and 1/10 near ones.

**New rule (spec §15.5):** in-scope score = `coverage × min(1, bestCos / cosRef)`. `coverage` is the importance-weighted share of the query's content words that occur in the document. The weights are the embedder's row norms, which already encode word rarity (model2vec's Zipf weighting), so no extra data is shipped.

| Rule | In-scope kept | Far rejected | Near rejected |
|---|---|---|---|
| cosine ≥ 0.30 | 45/46 | 11/15 | 1/10 |
| **coverage × min(1, cos/0.3) ≥ 0.55** | **45/46** | **15/15** | **7/10** |

Remaining errors:
- One paraphrase, "Why do chatbots struggle to count the letters in strawberry?", is rejected. Its words are not in the document. The panel still shows the closest passages.
- Three near-domain questions are accepted ("support vector machine", "gradient boosting", "cost to train GPT-4"). Their words do occur in the document. The extractive answer then quotes unrelated text, cited, which is visible but unhelpful.

These thresholds were tuned on 71 questions, so they are at risk of overfitting. Phase 4 adds held-out questions.

**FAQ matching:** threshold `faqMatch = 0.75`, plus two guards:
- at least 50% of the query's terms must occur in the entry's questions;
- a 0.1 penalty when the question word differs (what / where / why / how / when / who / which). Question words are stopwords, so neither cosine nor coverage sees them. Before this penalty, "what does layer norm do" matched "where is layer norm placed".

Result: 7/46 eval questions are answered from the FAQ, with 0 wrong sources and 0 out-of-scope FAQ hits. All other questions get an extractive answer quoted from the document.

## D-10 Runtime design and measured performance (Phase 2)

- **Engine without the DOM** (`packages/runtime/src/engine.ts`). The same code runs in the browser and in Node, for tests and calibration, so measured behaviour is shipped behaviour.
- **Two-stage load.** First the JSON blocks (keyword search, generated content, graph) make the panel usable. Then vectors and the embedder upgrade it to hybrid search. A damaged block degrades only its feature; e2e tests cover tampered vectors and tampered chunks.
- **Relation answers** use the concept-graph path for the chain. For each step, the supporting sentence is taken from the two concepts' sections and must name the other concept, matched as a whole phrase.
- **"This section"** means the section of the last cited passage while it is on screen; otherwise, the section whose heading is above the middle of the viewport.
- **Sizes:** runtime 35 KB JS + 7.5 KB CSS, minified, with no dependencies beyond our own core.

Measured with Playwright, from `file://` with the network off:

| Measurement | Chromium | Firefox | WebKit |
|---|---|---|---|
| Example (5.1 MB): runtime start → fully ready | 81 ms | 149 ms | 64 ms |
| Example: Q&A per question | ≤ 4 ms | ≤ 3 ms | ≤ 3 ms |
| Synthetic 337 pages (626 chunks, 7.2 MB): open → ready | 324 ms | 368 ms | 296 ms |
| Synthetic: search median / max | 0.4 / 0.4 ms | <1 / 1 ms | <1 / 1 ms |
| Synthetic: ask median / max | 0.8 / 9.9 ms | 1 / 6 ms | 1 / 9 ms |

Firefox and WebKit timers have 1 ms resolution. Chromium JS heap: 40 MB.
