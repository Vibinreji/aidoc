/**
 * End-to-end: dist/transformer.ai.html opened from file:// with the network disabled.
 * Any network request event fails the test (docs/decisions.md D-04).
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '../..');
const FILE = join(ROOT, 'dist/transformer.ai.html');
const URL_ = pathToFileURL(FILE).href;
const RESULTS = join(ROOT, 'tests/e2e/.results');
mkdirSync(RESULTS, { recursive: true });

function watchNetwork(ctx: BrowserContext, allowed: string[]) {
  const requests: string[] = [];
  ctx.on('request', (r) => {
    if (!allowed.includes(r.url())) requests.push(r.url());
  });
  return requests;
}

async function openDoc(page: Page, url = URL_) {
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__aidoc?.timings?.ready, null, { timeout: 30_000 });
}

async function ask(page: Page, q: string) {
  const before = await page.locator('.aidoc-answer').count();
  const input = page.getByRole('textbox', { name: 'Ask a question about this document' });
  if (!(await input.isVisible())) await page.getByRole('button', { name: 'Ask this document' }).click();
  await input.fill(q);
  await input.press('Enter');
  await expect(page.locator('.aidoc-answer')).toHaveCount(before + 1);
  const card = page.locator('.aidoc-answer').last();
  return { card, text: (await card.innerText()).replace(/\s+/g, ' '), kind: await card.getAttribute('data-kind'), ms: Number(await card.getAttribute('data-ms')) };
}

test.describe('transformer.ai.html offline', () => {
  test('required questions, features and zero network', async ({ page, context, browserName }) => {
    await context.setOffline(true);
    const requests = watchNetwork(context, [URL_]);
    const consoleErrors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    await openDoc(page);
    const diag = await page.evaluate(() => ({ errors: (window as any).__aidoc.errors, timings: (window as any).__aidoc.timings }));
    expect(diag.errors).toEqual([]);

    const log: Record<string, unknown> = { browser: browserName, timings: diag.timings };

    // 1. What is self-attention?
    let r = await ask(page, 'What is self-attention?');
    expect(['faq', 'extract']).toContain(r.kind);
    expect(r.text).toMatch(/same sequence/i);
    await expect(r.card.getByRole('button', { name: /Attention and self-attention/ })).toBeVisible();
    log.selfAttention = r;

    // 2. Explain Q, K and V
    r = await ask(page, 'Explain Q, K and V');
    expect(r.text).toMatch(/query/i);
    expect(r.text).toMatch(/key/i);
    expect(r.text).toMatch(/value/i);
    await expect(r.card.getByRole('button', { name: /Queries, keys and values/ })).toBeVisible();

    // 3. Relationship between embeddings and attention
    r = await ask(page, 'What is the relationship between embeddings and attention?');
    expect(r.kind).toBe('relation');
    expect(r.text).toMatch(/Attention .*turns into contextual representations.*Embedding/);
    expect(r.text).toMatch(/Found in the document/);
    await expect(r.card.getByRole('button', { name: 'Embeddings', exact: true })).toBeVisible();

    // 4. Summarize this section — while viewing Attention
    await page.locator('section[data-aidoc-id="attention"] h2').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(150);
    r = await ask(page, 'Summarize this section');
    expect(r.kind).toBe('generated');
    expect(r.text).toContain('Summary · Attention and self-attention');
    expect(r.text).toContain('Prepared by the author (AI-generated, not reviewed)');

    // 5. What is the KV cache for?
    r = await ask(page, 'What is the KV cache for?');
    expect(r.text).toMatch(/keys and values/i);
    await expect(r.card.getByRole('button', { name: /The KV cache/ })).toBeVisible();

    // 6. Out of scope
    r = await ask(page, 'Who won the 2022 World Cup?');
    expect(r.kind).toBe('notCovered');
    expect(r.text).toContain("This document doesn't seem to cover that.");

    // Search: results show a heading path; clicking scrolls to and highlights the passage.
    r = await ask(page, 'Where does it discuss rotary embeddings?');
    expect(r.kind).toBe('search');
    const firstHit = r.card.locator('.aidoc-hit').first();
    await expect(firstHit.locator('.aidoc-path')).toContainText('Positional encoding');
    await firstHit.click();
    const hl = page.locator('#aidoc-content .aidoc-hl');
    await expect(hl).toHaveCount(1);
    await expect(hl).toBeInViewport();
    await expect(hl).toContainText(/Rotary/);

    // Citation chip → scroll + highlight
    r = await ask(page, 'What is the KV cache for?');
    await r.card.getByRole('button', { name: /The KV cache/ }).click();
    await expect(page.locator('section[data-aidoc-id="kv-cache"] .aidoc-hl, section[data-aidoc-id="kv-cache"] h2.aidoc-hl').first()).toBeInViewport();

    // Quiz (quick action on the section in view: KV cache)
    await page.getByRole('button', { name: 'Quiz me', exact: true }).click();
    const quiz = page.locator('.aidoc-answer').last();
    await expect(quiz).toContainText('Quiz · The KV cache');
    const total = Number((await quiz.locator('.aidoc-muted').first().innerText()).match(/of (\d+)/)![1]);
    for (let i = 0; i < total; i++) {
      await quiz.locator('.aidoc-opt').first().click();
      await expect(quiz.locator('.aidoc-feedback')).toContainText(/Correct\.|Not quite\./);
      await quiz.locator('.aidoc-next').click();
    }
    await expect(quiz.locator('.aidoc-score')).toContainText(new RegExp(`You scored \\d+ out of ${total}`));

    // Explain simply, key concepts
    r = await ask(page, 'ELI5 Q/K/V');
    expect(r.text).toContain('In simple terms · Queries, keys and values');
    r = await ask(page, 'Key concepts in this section');
    expect(r.kind).toBe('concepts');

    // Latency of Q&A on this document (engine time, measured in the page)
    const lat: number[] = [];
    for (const q of ['What is a residual connection?', 'how big is the kv cache for llama', 'why scale by sqrt d_k', 'what does layer norm do']) lat.push((await ask(page, q)).ms);
    log.qaLatencyMs = lat;

    expect(requests, 'no network requests at all').toEqual([]);
    expect(consoleErrors.filter((e) => /Content Security Policy|CSP/i.test(e))).toEqual([]);
    writeFileSync(join(RESULTS, `e2e-${browserName}.json`), JSON.stringify(log, null, 2));
    await page.screenshot({ path: join(RESULTS, `panel-${browserName}.png`) });
  });

  test('keyboard: "/" opens and focuses, Escape closes', async ({ page }) => {
    await openDoc(page);
    await page.keyboard.press('/');
    await expect(page.getByRole('textbox', { name: 'Ask a question about this document' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#aidoc-panel')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Ask this document' })).toBeFocused();
  });

  test('reads without JavaScript: content present, no panel', async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto(URL_);
    await expect(page.locator('#aidoc-content h2').first()).toBeVisible();
    await expect(page.locator('#aidoc-content')).toContainText('KV cache');
    await expect(page.locator('#aidoc-ui')).toHaveCount(0);
    await ctx.close();
  });

  test('360 px mobile: bottom sheet, no horizontal scroll, dark mode', async ({ browser, browserName }) => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await openDoc(page);
    await page.getByRole('button', { name: 'Ask this document' }).click();
    const box = (await page.locator('#aidoc-panel').boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(360);
    expect(box.y).toBeGreaterThan(100);
    await ask(page, 'What is multi-head attention?');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(22, 22, 24)');
    await page.screenshot({ path: join(RESULTS, `mobile-dark-${browserName}.png`) });
    await ctx.close();
  });

  test('damaged data fails gracefully', async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), 'aidoc-damaged-'));
    const html = readFileSync(FILE, 'utf8');
    // Flip one base64 char in the vectors block → hash mismatch → BM25-only mode.
    const badVectors = html.replace(/(id="aidoc-vectors"[^>]*>)(.)/, (_m, a, c) => a + (c === 'A' ? 'B' : 'A'));
    writeFileSync(join(dir, 'v.ai.html'), badVectors);
    await openDoc(page, pathToFileURL(join(dir, 'v.ai.html')).href);
    await expect(page.locator('.aidoc-status')).toContainText('Semantic search is unavailable');
    const r = await ask(page, 'What is a residual connection?');
    expect(r.text).toMatch(/residual/i);

    // Damaged chunks → panel disabled with a message; document still readable.
    const badChunks = html.replace(/(id="aidoc-chunks"[^>]*>\[)/, '$1{"broken":');
    writeFileSync(join(dir, 'c.ai.html'), badChunks);
    await page.goto(pathToFileURL(join(dir, 'c.ai.html')).href);
    await page.getByRole('button', { name: 'Ask this document' }).click();
    await expect(page.locator('.aidoc-status')).toContainText('unavailable');
    await expect(page.locator('#aidoc-content')).toContainText('Positional encoding');
  });
});
