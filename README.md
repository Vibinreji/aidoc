# aidoc

**Documents that answer your questions, offline and private.**

An `.ai.html` file is a single HTML document you open by double-clicking. It reads like a normal document, and it has an **"Ask this document"** panel for search, cited answers, summaries, simple explanations, quizzes and a concept map. There's no app, no account and no network: a Content Security Policy blocks every request, and the only script that runs is the hash-pinned aidoc runtime.

There is no language model inside the file. The expensive AI work (summaries, quizzes, FAQ, concept graph) happens when the document is built and is stored as reviewable data. At read time the file only runs cheap, deterministic steps: BM25 keyword search, a small static embedder (model2vec `potion-base-8M`), and extracting sentences from the document.

> Status: early work in progress (format 0.1 draft). See [`docs/decisions.md`](docs/decisions.md) for measured results and open questions.

## Try it

```bash
npx pnpm@9 install
npx pnpm@9 build      # runtime + CLI
npx pnpm@9 example    # → dist/transformer.ai.html (downloads the embedder once, build time only)
npx pnpm@9 inspect    # size report + integrity check
```

Open `dist/transformer.ai.html` in any modern browser.

## Layout

- `spec/`: format specification `aidoc-0.1.md` and JSON Schemas (CC BY 4.0)
- `packages/core`: tokenizer, embedder, BM25, Markdown → sanitized content, chunking, packaging
- `packages/runtime`: the inline runtime and the panel UI
- `packages/cli`: `aidoc build | inspect`
- `examples/transformer`: sample document with generated content and concept graph
- `benchmarks/`: eval questions, calibration and scale benchmarks
- `tests/`: Playwright tests (`file://` platform probes, end-to-end with the network off)

## Licence

Code: Apache-2.0 ([LICENSE](LICENSE)). Specification and schemas: CC BY 4.0 ([LICENSE-SPEC](LICENSE-SPEC)). The bundled embedder `minishlab/potion-base-8M` is MIT.
