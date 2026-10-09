/**
 * Phase 0 platform probes: what actually works when an .ai.html file is opened
 * from file:// under a meta-tag CSP, in Chromium, Firefox and WebKit.
 *
 * Oracle for "no network": a local TCP server counts every connection attempt.
 * Any connection = the browser tried to reach the network.
 */
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

let server: Server;
let port = 0;
let connections = 0;
const dir = mkdtempSync(join(tmpdir(), 'aidoc-platform-'));

test.beforeAll(async () => {
  server = createServer((sock) => {
    connections++;
    sock.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  writeFileSync(join(dir, 'sibling.txt'), 'sibling file');
});
test.afterAll(() => server.close());

interface PageOpts {
  styleSrc?: boolean;
  wasm?: boolean;
  workerBlob?: boolean;
  extraHead?: string;
  body?: string;
  script?: string;
}

function buildPage(name: string, o: PageOpts): string {
  const style = 'h1{color:rgb(0, 128, 0)} .x{color:rgb(1, 2, 3)}';
  const script = (o.script ?? '').replaceAll('__PORT__', String(port));
  const csp = [
    "default-src 'none'",
    `script-src ${script ? sha256(script) : "'none'"}${o.wasm === false ? '' : " 'wasm-unsafe-eval'"}`,
    `style-src ${sha256(style)}`,
    'img-src data: blob:',
    "connect-src 'none'",
    o.workerBlob === false ? '' : 'worker-src blob:',
    "form-action 'none'",
    "base-uri 'none'",
  ]
    .filter(Boolean)
    .join('; ');
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${style}</style>
${o.extraHead ?? ''}
</head><body>
${(o.body ?? '').replaceAll('__PORT__', String(port))}
${script ? `<script>${script}</script>` : ''}
</body></html>`;
  const file = join(dir, `${name}.html`);
  writeFileSync(file, html);
  return pathToFileURL(file).href;
}

// Minimal module: (func (export "f") (result i32) i32.const 42)
const WASM_B64 = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, 0x03, 0x02, 0x01,
  0x00, 0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, 0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b,
]).toString('base64');

const PROBE_SCRIPT = `
(async () => {
  const R = {};
  const V = [];
  document.addEventListener('securitypolicyviolation', (e) => V.push(e.effectiveDirective + ' ' + (e.blockedURI || '')));
  const T = (p, ms = 1500) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error('timeout')), ms))]);
  const probe = async (name, fn) => { try { R[name] = { ok: true, v: await T(Promise.resolve().then(fn)) }; } catch (e) { R[name] = { ok: false, v: String(e && e.message || e) }; } };
  const URL_ = 'http://127.0.0.1:__PORT__/x';

  await probe('runtime_ran', () => true);
  await probe('isSecureContext', () => window.isSecureContext);
  await probe('data_block_json', () => JSON.parse(document.getElementById('d').textContent).hello);
  await probe('data_block_not_executed', () => window.__pwned === undefined);
  await probe('unhashed_inline_blocked', () => window.__unhashed === undefined);
  await probe('inline_handler_blocked', () => window.__handler === undefined);
  await probe('hashed_style_applied', () => getComputedStyle(document.querySelector('h1')).color);
  await probe('unhashed_style_blocked', () => getComputedStyle(document.querySelector('h2')).color);
  await probe('style_attr', () => getComputedStyle(document.getElementById('sa')).color);
  await probe('svg_presentation_attr', () => getComputedStyle(document.getElementById('svgr')).fill);
  await probe('cssom_set_allowed', () => { const el = document.getElementById('cs'); el.style.setProperty('color', 'rgb(9, 9, 9)'); return getComputedStyle(el).color; });
  await probe('data_img_loads', () => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => rej(new Error('err')); i.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; }));
  await probe('blob_img_loads', async () => { const b = await (await fetch('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7').catch(() => null))?.blob(); return b ? 'fetch(data:) allowed?!' : 'fetch(data:) blocked'; });
  await probe('fetch_http', () => fetch(URL_).then(() => 'REACHED'));
  await probe('fetch_relative_file', () => fetch('sibling.txt').then((r) => r.text()));
  await probe('fetch_file_parent_dir', () => fetch('../').then((r) => r.status + ' ' + r.url));
  await probe('fetch_file_absolute', () => fetch('file:///etc/hosts').then((r) => r.text()).then((t) => 'READ ' + t.length + ' bytes'));
  await probe('xhr_relative_file', () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.onload = () => res('READ ' + x.responseText); x.onerror = () => rej(new Error('xhr error')); x.open('GET', 'sibling.txt'); x.send(); }));
  await probe('xhr_http', () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.onload = () => res('REACHED'); x.onerror = () => rej(new Error('xhr error')); x.open('GET', URL_); x.send(); }));
  await probe('websocket', () => new Promise((res, rej) => { const w = new WebSocket('ws://127.0.0.1:__PORT__/'); w.onopen = () => res('REACHED'); w.onerror = () => rej(new Error('ws error')); }));
  await probe('eventsource', () => new Promise((res, rej) => { const s = new EventSource(URL_); s.onopen = () => res('REACHED'); s.onerror = () => { s.close(); rej(new Error('es error')); }; }));
  await probe('sendBeacon', () => navigator.sendBeacon(URL_, 'x'));
  await probe('img_http', () => new Promise((res, rej) => { const i = new Image(); i.onload = () => res('REACHED'); i.onerror = () => rej(new Error('img error')); i.src = URL_; }));
  await probe('dynamic_import_http', () => import(URL_).then(() => 'REACHED'));
  await probe('worker_http', () => new Promise((res, rej) => { try { const w = new Worker(URL_); w.onerror = () => rej(new Error('worker error')); setTimeout(() => res('no error in 1s'), 1000); } catch (e) { rej(e); } }));
  await probe('iframe_http', () => new Promise((res) => { const f = document.createElement('iframe'); f.src = URL_; document.body.appendChild(f); setTimeout(() => res('inserted'), 800); }));
  await probe('cssom_bg_http', () => { document.getElementById('cs').style.backgroundImage = 'url(' + URL_ + ')'; return new Promise((r) => setTimeout(() => r('set'), 500)); });
  await probe('wasm_instantiate', async () => { const bytes = Uint8Array.from(atob('${WASM_B64}'), (c) => c.charCodeAt(0)); const { instance } = await WebAssembly.instantiate(bytes); return instance.exports.f(); });
  await probe('blob_worker', () => new Promise((res, rej) => {
    const code = "onmessage = async (e) => { let net = 'n/a'; try { await fetch('" + URL_ + "'); net = 'REACHED'; } catch (err) { net = 'blocked'; } postMessage({ sum: e.data + 1, net }); }";
    const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    w.onmessage = (e) => res(e.data); w.onerror = (e) => rej(new Error('worker onerror ' + (e.message || '')));
    w.postMessage(41);
  }));
  await probe('decompression_stream_gzip', async () => {
    // gzip of "hello aidoc"
    const gz = Uint8Array.from(atob('H4sIAAAAAAAAE8tIzcnJV0jMTMlPBgDZNWNqCwAAAA=='), (c) => c.charCodeAt(0));
    const s = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(s).text();
  });
  await probe('crypto_subtle_sha256', async () => { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc')); return new Uint8Array(d)[0]; });
  await probe('blob_url_download_anchor', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' })); a.download = 'original.pdf'; document.body.appendChild(a); a.click(); return a.href.slice(0, 5); });

  await new Promise((r) => setTimeout(r, 300));
  R.violations = { ok: true, v: V };
  window.__results = R;
})();
`;

const PROBE_BODY = `
<h1>Hashed style</h1><h2>Unhashed style</h2>
<p id="sa" style="color: rgb(255, 0, 0)">style attribute</p>
<p id="cs">cssom</p>
<svg width="10" height="10"><rect id="svgr" width="10" height="10" fill="rgb(0, 0, 255)"/></svg>
<style>h2{color:rgb(255, 0, 0)}</style>
<script type="application/aidoc-test+json" id="d">{"hello":"world"}</script>
<script type="application/aidoc-test+json">window.__pwned = 1</script>
<script>window.__unhashed = 1</script>
<img src="data:," onerror="window.__handler = 1" alt="">
`;

test('runtime probes under CSP from file://', async ({ page, browserName }, info) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  const url = buildPage(`probe-${browserName}`, { body: PROBE_BODY, script: PROBE_SCRIPT });
  const before = connections;
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__results, null, { timeout: 25_000 });
  const results = await page.evaluate(() => (window as any).__results);
  await page.waitForTimeout(500);
  const report = {
    browser: browserName,
    tcpConnections: connections - before,
    requests: requests.filter((u) => !u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('blob:')),
    fileRequests: requests.filter((u) => u.startsWith('file:')),
    downloads,
    results,
  };
  await info.attach('report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  writeFileSync(join(process.cwd(), 'tests/platform/.results', `probe-${browserName}.json`), JSON.stringify(report, null, 2));

  // Hard requirements
  expect(report.tcpConnections, 'no TCP connection may be attempted').toBe(0);
  expect(results.runtime_ran.ok).toBe(true);
  expect(results.data_block_json.v).toBe('world');
  expect(results.data_block_not_executed.v).toBe(true);
  expect(results.unhashed_inline_blocked.v).toBe(true);
  expect(results.inline_handler_blocked.v).toBe(true);
  expect(results.hashed_style_applied.v).toBe('rgb(0, 128, 0)');
  expect(results.unhashed_style_blocked.v).not.toBe('rgb(255, 0, 0)');
  expect(results.fetch_http.ok).toBe(false);
  expect(results.xhr_http.ok).toBe(false);
  expect(results.data_img_loads.v).toBe(1);
  expect(results.fetch_relative_file.ok).toBe(false);
  expect(results.xhr_relative_file.ok).toBe(false);
  expect(results.fetch_file_absolute.ok).toBe(false);
});

test('WASM without wasm-unsafe-eval', async ({ page, browserName }) => {
  const script = `(async()=>{try{const b=Uint8Array.from(atob('${WASM_B64}'),c=>c.charCodeAt(0));const {instance}=await WebAssembly.instantiate(b);window.__r='allowed '+instance.exports.f();}catch(e){window.__r='blocked: '+e.message;}})();`;
  await page.goto(buildPage(`nowasm-${browserName}`, { script, wasm: false }));
  await page.waitForFunction(() => (window as any).__r);
  const r = await page.evaluate(() => (window as any).__r);
  writeFileSync(join(process.cwd(), 'tests/platform/.results', `nowasm-${browserName}.json`), JSON.stringify(r));
});

test('blob worker without worker-src', async ({ page, browserName }) => {
  const script = `try{const w=new Worker(URL.createObjectURL(new Blob(['postMessage(1)'],{type:'text/javascript'})));w.onmessage=()=>window.__r='allowed';w.onerror=()=>window.__r='blocked (onerror)';setTimeout(()=>window.__r=window.__r||'no response',1500);}catch(e){window.__r='blocked: '+e.message;}`;
  await page.goto(buildPage(`noworker-${browserName}`, { script, workerBlob: false }));
  await page.waitForFunction(() => (window as any).__r, null, { timeout: 5000 });
  const r = await page.evaluate(() => (window as any).__r);
  writeFileSync(join(process.cwd(), 'tests/platform/.results', `noworker-${browserName}.json`), JSON.stringify(r));
});

/**
 * Static markup that might fetch on its own, with NO script at all. CSP blocks most of these;
 * anything that still connects must be stripped by the build-time sanitizer.
 */
const MARKUP_CASES: Record<string, { head?: string; body?: string }> = {
  link_preconnect: { head: `<link rel="preconnect" href="http://127.0.0.1:__PORT__">` },
  link_prefetch: { head: `<link rel="prefetch" href="http://127.0.0.1:__PORT__/p">` },
  link_preload: { head: `<link rel="preload" as="image" href="http://127.0.0.1:__PORT__/p">` },
  link_stylesheet: { head: `<link rel="stylesheet" href="http://127.0.0.1:__PORT__/s.css">` },
  link_icon: { head: `<link rel="icon" href="http://127.0.0.1:__PORT__/f.ico">` },
  img: { body: `<img src="http://127.0.0.1:__PORT__/i.png">` },
  img_srcset: { body: `<img srcset="http://127.0.0.1:__PORT__/i.png 1x">` },
  picture_source: { body: `<picture><source srcset="http://127.0.0.1:__PORT__/i.png"><img alt=""></picture>` },
  video_poster: { body: `<video poster="http://127.0.0.1:__PORT__/p.png"></video>` },
  audio_src: { body: `<audio src="http://127.0.0.1:__PORT__/a.mp3" preload="auto"></audio>` },
  iframe: { body: `<iframe src="http://127.0.0.1:__PORT__/f"></iframe>` },
  object: { body: `<object data="http://127.0.0.1:__PORT__/o"></object>` },
  embed: { body: `<embed src="http://127.0.0.1:__PORT__/e">` },
  svg_image: { body: `<svg><image href="http://127.0.0.1:__PORT__/i.png" width="10" height="10"/></svg>` },
  svg_use: { body: `<svg><use href="http://127.0.0.1:__PORT__/u.svg#a"/></svg>` },
  input_image: { body: `<input type="image" src="http://127.0.0.1:__PORT__/i.png">` },
  meta_refresh: { head: `<meta http-equiv="refresh" content="0;url=http://127.0.0.1:__PORT__/r">` },
  style_attr_bg: { body: `<div style="background:url(http://127.0.0.1:__PORT__/b.png);width:9px;height:9px"></div>` },
  a_ping_not_clicked: { body: `<a href="#x" ping="http://127.0.0.1:__PORT__/ping">x</a>` },
  form_autosubmit_none: { body: `<form action="http://127.0.0.1:__PORT__/f"><input name="q"></form>` },
};

test('markup that could fetch without script', async ({ page, browserName }) => {
  const out: Record<string, number> = {};
  for (const [name, c] of Object.entries(MARKUP_CASES)) {
    const before = connections;
    const url = buildPage(`markup-${name}-${browserName}`, {
      extraHead: c.head?.replaceAll('__PORT__', String(port)),
      body: c.body,
    });
    await page.goto(url).catch(() => {});
    await page.waitForTimeout(1200);
    out[name] = connections - before;
  }
  // Also: clicking an <a ping> link (hyperlink auditing is governed by connect-src)
  {
    const before = connections;
    await page.goto(buildPage(`markup-ping-click-${browserName}`, { body: MARKUP_CASES.a_ping_not_clicked!.body })).catch(() => {});
    await page.click('a').catch(() => {});
    await page.waitForTimeout(1200);
    out.a_ping_clicked = connections - before;
  }
  writeFileSync(join(process.cwd(), 'tests/platform/.results', `markup-${browserName}.json`), JSON.stringify(out, null, 2));
});
