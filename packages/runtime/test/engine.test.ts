import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { engineFor, MODEL_DIR, ROOT } from '../../../benchmarks/lib.ts';
import type { Engine } from '../src/engine.ts';
import { readBlocks, decodeJson } from '../../core/src/node/read.ts';
import { parseMarkdown } from '../../core/src/node/document.ts';
import { buildBm25 } from '../../core/src/search/bm25.ts';
import { indexText } from '../../core/src/node/document.ts';
import { toHtml } from 'hast-util-to-html';

const hasModel = existsSync(join(MODEL_DIR, 'model.safetensors'));

describe('sanitizer (spec §7)', () => {
  it('removes everything that could run code or reach the network', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aidoc-san-'));
    writeFileSync(
      join(dir, 'document.md'),
      `# Evil {#evil}

<script>alert(1)</script>
<img src="x" onerror="alert(1)">
<img src="https://example.com/track.png">
<a href="javascript:alert(1)">js link</a>
<a href="https://example.com" target="_top">ext</a>
<p style="background:url(https://example.com/x)">styled</p>
<meta http-equiv="refresh" content="0;url=https://example.com">
<link rel="preconnect" href="https://example.com">
<iframe src="https://example.com"></iframe>
<object data="x"></object>
<form action="https://example.com"><input name="q"></form>
<svg><image href="https://example.com/i.png"/><use href="https://example.com/u.svg#a"/><a href="https://x"><text>t</text></a><foreignObject><p>x</p></foreignObject><rect fill="url(https://example.com/#p)"/></svg>
<base href="https://example.com/">
<div id="aidoc-manifest" name="x">clobber</div>
<!-- comment -->

Normal **text** stays.
`,
    );
    const doc = parseMarkdown(join(dir, 'document.md'));
    const html = toHtml({ type: 'root', children: doc.sections.flatMap((s) => s.children) });
    for (const bad of ['<script', 'onerror', 'javascript:', 'track.png', '<iframe', '<object', '<form', '<input', 'refresh', 'preconnect', '<link', '<meta', 'foreignObject', 'style=', '<base', 'aidoc-manifest', 'name=', '<!--', '_top', 'url(https', 'example.com/i.png', 'u.svg']) {
      expect(html, bad).not.toContain(bad);
    }
    expect(html).toContain('noopener');
    expect(html).toContain('Normal ');
  });
});

describe.skipIf(!hasModel)('engine on the Transformer example', () => {
  let engine: Engine;
  let html: string;
  beforeAll(() => {
    const r = engineFor(128);
    engine = r.engine;
    html = r.res.html;
  });

  it('answers the required questions with citations', () => {
    const a1 = engine.ask('What is self-attention?').answer;
    expect(['faq', 'extract']).toContain(a1.kind);
    expect(JSON.stringify(a1)).toMatch(/same sequence/);
    expect('citations' in a1 && a1.citations.map((c) => c.sectionId)).toContain('attention');

    const a2 = engine.ask('Explain Q, K and V').answer;
    expect('citations' in a2 && a2.citations.map((c) => c.sectionId)).toContain('qkv');

    const a3 = engine.ask('What is the relationship between embeddings and attention?').answer;
    expect(a3.kind).toBe('relation');
    if (a3.kind === 'relation') {
      expect(a3.path.length).toBeGreaterThan(0);
      expect(a3.sentences.length).toBeGreaterThan(0);
    }

    const a4 = engine.ask('Summarize this section', { currentSectionId: 'attention' }).answer;
    expect(a4.kind === 'generated' && a4.mode === 'summary' && a4.sectionId).toBe('attention');

    const a5 = engine.ask('What is the KV cache for?').answer;
    expect('citations' in a5 && a5.citations.map((c) => c.sectionId)).toContain('kv-cache');

    expect(engine.ask('Who won the 2022 World Cup?').answer.kind).toBe('notCovered');
  });

  it('routes intents', () => {
    const r = (q: string, cur?: string) => engine.route(q, { currentSectionId: cur }).intent;
    expect(r('quiz me')).toBe('quiz');
    expect(r('test me on attention')).toBe('quiz');
    expect(r('ELI5 Q/K/V')).toBe('simple');
    expect(r('explain simply')).toBe('simple');
    expect(r('summary of attention')).toBe('summary');
    expect(r('where does it discuss embeddings')).toBe('find');
    expect(r('how does X relate to Y')).toBe('question'); // unknown concepts → plain question
    expect(r('how does the kv cache relate to the causal mask')).toBe('relation');
    expect(r('How does BERT attention differ from GPT attention?')).toBe('question');
    expect(engine.route('test me on attention').sectionId).toBe('attention');
  });

  it('meets retrieval and out-of-scope floors on the eval set', () => {
    const ev = JSON.parse(readFileSync(join(ROOT, 'benchmarks/eval/transformer.json'), 'utf8'));
    let hit3 = 0;
    for (const it of ev.inScope) {
      const { order } = engine.retrieve(it.q);
      if (order.slice(0, 3).some((ci) => it.sections.includes(engine.d.chunks[ci]!.sectionId))) hit3++;
    }
    expect(hit3 / ev.inScope.length).toBeGreaterThanOrEqual(0.9);
    const kept = ev.inScope.filter((it: { q: string }) => !engine.isOutOfScope(it.q)).length;
    const rejected = ev.outOfScope.filter((o: { q: string }) => engine.isOutOfScope(o.q)).length;
    expect(kept / ev.inScope.length).toBeGreaterThanOrEqual(0.95);
    expect(rejected / ev.outOfScope.length).toBeGreaterThanOrEqual(0.85);
  });

  it('built file validates against the JSON Schemas and is internally consistent', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    (addFormats as unknown as (a: unknown) => void)(ajv);
    const schema = (n: string) => JSON.parse(readFileSync(join(ROOT, 'spec/schemas', `${n}.schema.json`), 'utf8'));
    const blocks = readBlocks(html);
    const check = (name: string, id: string) => {
      const v = ajv.compile(schema(name));
      const data = decodeJson(blocks.get(id));
      expect(v(data), `${name}: ${ajv.errorsText(v.errors)}`).toBe(true);
      return data as any;
    };
    const manifest = check('manifest', 'aidoc-manifest');
    const chunks = check('chunks', 'aidoc-chunks');
    const bm25 = check('bm25', 'aidoc-bm25');
    check('generated', 'aidoc-generated');
    check('graph', 'aidoc-graph');
    // BM25 block equals a rebuild from chunks (spec §11.2)
    expect(buildBm25(chunks.map(indexText), manifest.language)).toEqual(bm25);
    // Exact size and head order
    expect(Buffer.byteLength(html)).toBe(manifest.sizes.total);
    expect(html).toMatch(/^<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]{44}'; style-src 'sha256-[A-Za-z0-9+/=]{44}'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">\n<meta name="viewport"/);
    expect(html).not.toContain('<!--');
  });
});
