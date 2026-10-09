/** Build the runtime (inline IIFE + CSS) and the CLI bundle. Usage: node scripts/build.ts */
import { build, transform } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const rt = join(ROOT, 'packages/runtime');
mkdirSync(join(rt, 'dist'), { recursive: true });

const js = await build({
  entryPoints: [join(rt, 'src/main.ts')],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  target: ['chrome111', 'firefox113', 'safari16.4'],
  legalComments: 'none',
  charset: 'ascii',
  platform: 'browser',
});
let code = js.outputFiles[0]!.text.trim();
if (/<\/script|<!--/i.test(code)) throw new Error('runtime bundle contains </script or <!--');
const css = (await transform(readFileSync(join(rt, 'src/style.css'), 'utf8'), { loader: 'css', minify: true, target: ['chrome111', 'firefox113', 'safari16.4'] })).code.trim();
const version = JSON.parse(readFileSync(join(rt, 'package.json'), 'utf8')).version;
writeFileSync(join(rt, 'dist/runtime.js'), code);
writeFileSync(join(rt, 'dist/style.css'), css);
writeFileSync(join(rt, 'dist/runtime.json'), JSON.stringify({ version }, null, 2));
console.log(`runtime ${version}: js ${(code.length / 1024).toFixed(1)} KB, css ${(css.length / 1024).toFixed(1)} KB`);

const cli = join(ROOT, 'packages/cli');
await build({
  entryPoints: [join(cli, 'src/aidoc.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(cli, 'dist/aidoc.js'),
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
});
chmodSync(join(cli, 'dist/aidoc.js'), 0o755);
console.log('cli: packages/cli/dist/aidoc.js');
