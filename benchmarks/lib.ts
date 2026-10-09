/** Shared helpers for benchmarks, calibration and tests. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, loadEngineData, prepareEmbedder } from '../packages/core/src/node/index.ts';
import { Engine } from '../packages/runtime/src/engine.ts';

export const ROOT = join(import.meta.dirname, '..');
export const MODEL_DIR = join(ROOT, '.cache/models/potion-base-8M');
export const DEFAULT_THRESHOLDS = { outOfScope: 0.55, cosRef: 0.3, faqMatch: 0.75 };

export function embedderPayload(pca: number | null): Uint8Array {
  const dir = join(ROOT, '.cache/embedders');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `potion-base-8M-${pca ?? 'full'}.aide`);
  if (existsSync(f)) return new Uint8Array(readFileSync(f));
  const p = prepareEmbedder({ modelDir: MODEL_DIR, modelId: 'minishlab/potion-base-8M', license: 'MIT', pca });
  writeFileSync(f, p.payload);
  return p.payload;
}

export function engineFor(pca: number | null, thresholds = DEFAULT_THRESHOLDS, sourceDir = join(ROOT, 'examples/transformer')) {
  const res = build({ sourceDir, embedderPayload: embedderPayload(pca), embedderLicense: 'MIT', runtime: { version: '0.1.0', js: '/*node*/', css: '' }, thresholds });
  return { engine: new Engine(loadEngineData(res.html) as never), res };
}
