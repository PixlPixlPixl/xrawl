/**
 * End-to-end verification of the word-discovery debug harness.
 *
 * Loads the built extension into Chromium, serves a fixture page, then asks
 * the content script for snapshots through the extension's own messaging
 * protocol (via the background service worker). Also inspects the overlay,
 * tooltip, scroll/resize behaviour, and idle stability.
 *
 * Run with:  npm run verify
 * In a headless environment:  xvfb-run -a node test/verify.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdirSync, existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, '..');
const extensionDir = path.join(rootDir, '.output', 'chrome-mv3');
const fixturePath = path.join(testDir, 'fixtures', 'page.html');
const profileDir = path.join(rootDir, '.test-profile');

function findCachedChromium() {
  const cacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? process.env.PLAYWRIGHT_BROWSERS_PATH
    : path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cacheRoot)) return null;

  for (const entry of readdirSync(cacheRoot)) {
    if (!entry.startsWith('chromium-')) continue;
    for (const folder of ['chrome-linux64', 'chrome-linux']) {
      const candidate = path.join(cacheRoot, entry, folder, 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    findCachedChromium(),
    chromium.executablePath(),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((value) => typeof value === 'string' && value.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('No Chromium/Chrome executable found; set CHROME_PATH.');
}

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    checks.push({ name, ok: false, error });
    console.log(`  \u2717 ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function byWord(snapshot, word) {
  return snapshot.targets.find((target) => target.normalized === word) ?? null;
}

function rectsSignature(target) {
  return target.rects
    .map((rect) => `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`)
    .join('|');
}

function sumRectCount(targets) {
  return targetByRectCount(targets);
}

function targetByRectCount(targets) {
  return targets.reduce((total, target) => total + target.rects.length, 0);
}

async function main() {
  if (!existsSync(path.join(extensionDir, 'manifest.json')) ) {
    throw new Error('Extension not built. Run `npm run build` first.');
  }

  await rm(profileDir, { recursive: true, force: true });

  const fixture = await readFile(fixturePath, 'utf8');
  const server = createServer((request, response) => {
    if (request.url === '/' || request.url === '/page.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(fixture);
      return;
    }
    response.writeHead(404).end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: chromeExecutable(),
    viewport: { width: 1000, height: 800 },
    acceptDownloads: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });

  let serviceWorker = context.serviceWorkers()[0] ?? null;
  if (serviceWorker === null) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  }

  const page = await context.newPage();
  await page.goto(`${origin}/page.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-xrawl-active'));

  const tabId = await serviceWorker.evaluate(async (prefix) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => typeof tab.url === 'string' && tab.url.startsWith(prefix))?.id ?? null;
  }, origin);
  assert.notEqual(tabId, null, 'fixture tab id not found');

  const ask = (request) =>
    serviceWorker.evaluate(
      async ({ tabId: id, request: payload }) => {
        try {
          return await chrome.tabs.sendMessage(id, payload);
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      },
      { tabId, request },
    );

  async function waitForSnapshot(predicate, timeoutMs = 15_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const response = await ask({ type: 'xrawl/get-snapshot' });
      if (response?.ok && predicate(response.data.snapshot)) return response.data.snapshot;
      await sleep(120);
    }
    throw new Error('timed out waiting for a matching snapshot');
  }

  const first = await waitForSnapshot(
    (snapshot) => snapshot.targets.length > 0 && snapshot.stats.passes >= 1,
  );

  console.log('\nWord discovery');

  await check('paragraph words are discovered in reading order', () => {
    for (const word of ['quick', 'brown', 'fox', 'jumps', 'lazy', 'dog']) {
      assert.ok(byWord(first, word), `missing word "${word}"`);
    }
    assert.ok(byWord(first, 'codeblockword'), 'preformatted text should be discoverable');
  });

  await check('original text is preserved and normalized form is lowercased', () => {
    const quick = byWord(first, 'quick');
    assert.equal(quick.text, 'quick');
    const the = first.targets.find((target) => target.text === 'The');
    assert.ok(the, 'expected the capitalized article "The"');
    assert.equal(the.normalized, 'the');
  });

  await check('wrapped words carry multiple rectangles', () => {
    const wrapped = byWord(first, 'pneumonoultramicroscopicsilicovolcanoconiosis');
    assert.ok(wrapped, 'wrapped word missing');
    assert.ok(wrapped.rects.length >= 2, `expected >=2 rects, got ${wrapped.rects.length}`);
    for (const rect of wrapped.rects) {
      assert.ok(rect.width > 0 && rect.height > 0, 'rects must have positive size');
      assert.ok(Number.isFinite(rect.x) && Number.isFinite(rect.y), 'rects must be finite');
    }
  });

  await check('context sentence and surrounding text are populated', () => {
    const quick = byWord(first, 'quick');
    assert.match(quick.context.sentence, /The quick brown fox jumps over the lazy dog/);
    assert.match(quick.context.surrounding, /quick brown fox/);
  });

  await check('inline-split text nodes receive full surrounding context', () => {
    const gamma = byWord(first, 'gamma');
    assert.ok(gamma, 'inline-split word missing');
    assert.match(gamma.context.surrounding, /Alpha/);
    assert.match(gamma.context.surrounding, /delta/);
  });

  await check('page url, title, environment, and source metadata are present', () => {
    const quick = byWord(first, 'quick');
    assert.equal(quick.page.url, `${origin}/page.html`);
    assert.match(quick.page.title, /Xrawl perception fixture/i);
    assert.equal(quick.environment, 'article');
    assert.equal(first.environment.kind, 'article');
    assert.ok(quick.source.nodeId.length > 0);
    assert.ok(Number.isInteger(quick.source.segmentIndex));
  });

  await check('target ids and fingerprints are unique, all required fields exist', () => {
    const ids = new Set(first.targets.map((target) => target.id));
    const fingerprints = new Set(first.targets.map((target) => target.fingerprint));
    assert.equal(ids.size, first.targets.length);
    assert.equal(fingerprints.size, first.targets.length);
    for (const target of first.targets) {
      for (const field of [
        'id',
        'fingerprint',
        'text',
        'normalized',
        'rects',
        'visibility',
        'context',
        'page',
        'environment',
        'scanOrder',
        'source',
      ]) {
        assert.ok(field in target, `target missing field ${field}`);
      }
      assert.equal(typeof target.visibility.inViewport, 'boolean');
      assert.ok(target.visibility.viewportRatio >= 0 && target.visibility.viewportRatio <= 1);
    }
  });

  await check('hidden content is excluded', () => {
    for (const word of [
      'clandestinetoken',
      'stealthtoken',
      'veiledtoken',
      'opacityghosttoken',
    ]) {
      assert.equal(byWord(first, word), null, `hidden word "${word}" leaked into targets`);
    }
  });

  await check('editable and sensitive content is excluded', () => {
    for (const word of ['editableprose', 'editabletextarea', 'sensitiveformlabel']) {
      assert.equal(byWord(first, word), null, `editable/sensitive word "${word}" leaked`);
    }
  });

  await check('overlay-owned and non-text subtrees are excluded', () => {
    for (const word of [
      'overlayleaktoken',
      'buttonlabelword',
      'svgword',
      'scriptword',
      'templateword',
    ]) {
      assert.equal(byWord(first, word), null, `non-content word "${word}" leaked`);
    }
  });

  await check('statistics agree with the target list', () => {
    assert.equal(first.stats.targetCount, first.targets.length);
    assert.equal(first.stats.rectCount, sumRectCount(first.targets));
    assert.equal(
      first.stats.visibleInViewport,
      first.targets.filter((target) => target.visibility.inViewport).length,
    );
    assert.ok(first.stats.uniqueWordCount > 0);
    assert.ok(first.stats.topWords.length > 0);
  });

  await check('debug overlay and HUD are visible', async () => {
    const hud = await page.locator('[data-xrawl-overlay="hud"]').textContent();
    assert.ok(hud, 'HUD missing');
    assert.match(hud, new RegExp(`${first.stats.targetCount} words`));
    const canvasDisplay = await page.evaluate(() => {
      const canvas = document.querySelector('canvas[data-xrawl-overlay="canvas"]');
      return canvas ? canvas.style.display : null;
    });
    assert.equal(canvasDisplay, 'block');
  });

  await check('hovering a word shows its details in the tooltip', async () => {
    const quick = byWord(first, 'quick');
    const rect = quick.rects[0];
    const scroll = first.viewport.scroll;
    await page.mouse.move(
      rect.x - scroll.x + rect.width / 2,
      rect.y - scroll.y + rect.height / 2,
    );
    await sleep(250);
    const tooltip = page.locator('[data-xrawl-overlay="tooltip"]');
    assert.equal(await tooltip.evaluate((node) => node.style.display), 'block');
    const text = await tooltip.textContent();
    assert.match(text, /quick/);
    assert.match(text, /rect/);
    assert.match(text, /quick brown fox/);
    await page.mouse.move(4, 4);
  });

  console.log('\nScroll and resize');

  const footerBefore = byWord(first, 'footerwordtarget');
  assert.ok(footerBefore, 'below-the-fold word missing');
  const footerRectsBefore = rectsSignature(footerBefore);
  assert.equal(footerBefore.visibility.inViewport, false, 'footer should start below the fold');

  await check('scrolling updates viewport visibility without moving document rects', async () => {
    await page.evaluate(() => window.scrollTo(0, 1800));
    await sleep(350);
    const afterScroll = (await ask({ type: 'xrawl/get-snapshot' })).data.snapshot;
    const footerAfter = byWord(afterScroll, 'footerwordtarget');
    assert.ok(footerAfter, 'footer word disappeared after scroll');
    assert.equal(footerAfter.visibility.inViewport, true, 'footer should enter the viewport');
    assert.equal(rectsSignature(footerAfter), footerRectsBefore, 'document-space rects must be scroll-stable');
    assert.ok(
      afterScroll.stats.visibleInViewport !== first.stats.visibleInViewport,
      'visible count should change with scroll',
    );
  });

  await check('unchanged text is not rescanned while idle', async () => {
    const before = (await ask({ type: 'xrawl/get-stats' })).data.stats;
    await sleep(1_500);
    const after = (await ask({ type: 'xrawl/get-stats' })).data.stats;
    assert.equal(after.passes, before.passes, `passes increased while idle: ${before.passes} -> ${after.passes}`);
  });

  await check('resizing re-measures geometry and reports a resize pass', async () => {
    const before = (await ask({ type: 'xrawl/get-stats' })).data.stats;
    const beforeSnapshot = (await ask({ type: 'xrawl/get-snapshot' })).data.snapshot;
    const probeBefore = rectsSignature(byWord(beforeSnapshot, 'resizeprobe'));

    await page.setViewportSize({ width: 620, height: 700 });

    const resized = await waitForSnapshot(
      (snapshot) =>
        snapshot.stats.passes > before.passes && snapshot.stats.lastPassKind === 'resize',
      10_000,
    );
    const probeAfter = rectsSignature(byWord(resized, 'resizeprobe'));
    assert.notEqual(probeAfter, probeBefore, 'geometry should change after resize');
  });

  await check('manual rescan of unchanged content reports no change and reuses segmentation', async () => {
    const before = (await ask({ type: 'xrawl/get-stats' })).data.stats;
    const rescanResponse = await ask({ type: 'xrawl/rescan' });
    assert.ok(rescanResponse?.ok, 'rescan request failed');

    const after = await waitForSnapshot(
      (snapshot) => snapshot.stats.passes > before.passes && snapshot.stats.lastPassKind === 'manual',
      10_000,
    );
    assert.equal(after.stats.lastPassChanged, false, 'unchanged rescan should not report changes');
    assert.equal(
      after.stats.segmentation.misses,
      before.segmentation.misses,
      'segmentation cache should prevent re-parsing unchanged text',
    );
    assert.equal(
      after.stats.segmentation.hits,
      before.segmentation.hits,
      'unchanged text nodes should not even need cache lookups',
    );
  });

  console.log('\nDynamic content and controls');

  await check('dynamically added text is detected', async () => {
    const before = (await ask({ type: 'xrawl/get-stats' })).data.stats;
    await page.evaluate(() => {
      const paragraph = document.createElement('p');
      paragraph.id = 'dynamic-paragraph';
      paragraph.textContent = 'dynamicallyappendedword mutationprobe';
      document.body.append(paragraph);
    });

    const updated = await waitForSnapshot(
      (snapshot) =>
        byWord(snapshot, 'dynamicallyappendedword') !== null &&
        snapshot.stats.passes > before.passes,
      10_000,
    );
    assert.ok(byWord(updated, 'mutationprobe'));
  });

  await check('dynamically removed text is dropped', async () => {
    await page.evaluate(() => document.getElementById('dynamic-paragraph')?.remove());
    const updated = await waitForSnapshot(
      (snapshot) => byWord(snapshot, 'dynamicallyappendedword') === null,
      10_000,
    );
    assert.equal(byWord(updated, 'dynamicallyappendedword'), null);
  });

  await check('overlay can be toggled through the message API', async () => {
    const off = await ask({ type: 'xrawl/set-overlay', visible: false });
    assert.ok(off?.ok);
    assert.equal(off.data.overlayVisible, false);
    const hidden = await page.evaluate(
      () => document.querySelector('canvas[data-xrawl-overlay="canvas"]')?.style.display ?? 'missing',
    );
    assert.equal(hidden, 'none');

    const on = await ask({ type: 'xrawl/set-overlay', visible: true });
    assert.ok(on?.ok);
    assert.equal(on.data.overlayVisible, true);
    const shown = await page.evaluate(
      () => document.querySelector('canvas[data-xrawl-overlay="canvas"]')?.style.display ?? 'missing',
    );
    assert.equal(shown, 'block');
  });

  await check('keyboard shortcut toggles outlines', async () => {
    await page.keyboard.press('Alt+Shift+X');
    await sleep(120);
    const display = await page.evaluate(
      () => document.querySelector('canvas[data-xrawl-overlay="canvas"]')?.style.display ?? 'missing',
    );
    assert.equal(display, 'none');
    await page.keyboard.press('Alt+Shift+X');
    await sleep(120);
  });

  await check('snapshot export downloads valid JSON', async () => {
    const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
    const response = await ask({ type: 'xrawl/download-snapshot' });
    assert.ok(response?.ok, 'download request failed');
    const download = await downloadPromise;
    const file = await download.path();
    assert.ok(file, 'download has no file path');
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(parsed.snapshot.targets.length > 0);
    assert.equal(parsed.exportedTargetCount, parsed.snapshot.targets.length);
    assert.ok(byWord(parsed.snapshot, 'quick'));
  });

  await check('popup boots and reports the offline state on an extension tab', async () => {
    const extensionId = new URL(serviceWorker.url()).host;
    const popupTab = await context.newPage();
    await popupTab.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'load' });
    await popupTab.waitForFunction(
      () => document.getElementById('error')?.dataset.show === 'true',
      undefined,
      { timeout: 5_000 },
    );
    const errorText = await popupTab.locator('#error').textContent();
    assert.match(errorText, /not running on this tab|Reload/i);
    const brand = await popupTab.locator('.brand').textContent();
    assert.equal(brand.trim(), 'xrawl');
    await popupTab.close();
  });

  await check('popup renders live stats when the fixture tab is active', async () => {
    const extensionId = new URL(serviceWorker.url()).host;
    const popupTab = await context.newPage();
    await popupTab.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'load' });
    await page.bringToFront();
    await popupTab.reload({ waitUntil: 'load' });

    await popupTab.waitForFunction(
      () => {
        const value = document.getElementById('stat-targets')?.textContent ?? '';
        return Number(value) > 0;
      },
      undefined,
      { timeout: 8_000 },
    );

    const title = await popupTab.locator('#page-title').textContent();
    assert.match(title ?? '', /Perception fixture/i);
    const topWordItems = await popupTab.locator('#top-words li').count();
    assert.ok(topWordItems > 0, 'top words should render');
    const env = await popupTab.locator('#env').textContent();
    assert.match(env ?? '', /article/i);
    const toggleLabel = await popupTab.locator('#toggle').textContent();
    assert.match(toggleLabel ?? '', /outlines/i);
    await popupTab.close();
  });

  await context.close();
  await new Promise((resolve) => server.close(resolve));

  const failures = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const failure of failures) {
      console.log(` - ${failure.name}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
