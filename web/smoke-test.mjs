// Smoke test of one engine build in a real (headless) browser, before it is
// published. Used by web/upstream-build.sh.
//
// Usage: node web/smoke-test.mjs <site-url> <build-id> [<Dungeon Keeper folder>]
//   <site-url>  a served site with the page and builds/ (web/serve.py --layout)
//   Without a DK folder (CI has none): the build must load, read its data
//   list and ask for the DK files (state "setup"). With one: it must also
//   start, show frames for a while and report its version in the log.
// Needs playwright-core installed in the current directory (npm i
// playwright-core) and a Chromium (CHROMIUM=/path, default /usr/bin/chromium).
// Exit code 0 when the build works.
import { createRequire } from 'node:module';

const { chromium } = createRequire(`${process.cwd()}/`)('playwright-core');

const [url, buildId, dkDir] = process.argv.slice(2);
if (!url || !buildId) {
  console.error('Usage: node web/smoke-test.mjs <site-url> <build-id> [<DK folder>]');
  process.exit(2);
}
const fail = (msg) => { console.error(`SMOKE FAIL ${buildId}: ${msg}`); process.exitCode = 1; };

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/usr/bin/chromium',
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const target = new URL(url);
target.searchParams.set('build', buildId);
target.searchParams.set('args', '-nointro -level 1');
target.hash = '#/play';
const state = () => page.evaluate(() => window.KFX && KFX.state);
const waitState = async (want, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const s = await state().catch(() => null);
    if (want.includes(s) || s === 'failed' || Date.now() > end) return s;
    await page.waitForTimeout(500);
  }
};

try {
  await page.goto(target.href);
  let s = await waitState(['setup', 'ready'], 120000);
  const running = await page.evaluate(() => (typeof Versions !== 'undefined' && Versions.current ? Versions.current.id : null));
  if (running !== buildId) fail(`the page runs ${running}, not ${buildId}`);
  if (s !== 'setup' && s !== 'ready') fail(`stuck in state ${s}: ${await page.evaluate(() => document.getElementById('status')?.textContent)}`);
  else if (dkDir) {
    if (s === 'setup') {
      await page.setInputFiles('#dk-folder', dkDir);
      s = await waitState(['ready'], 60000);
    }
    await page.evaluate(() => document.getElementById('start-button').click());
    s = await waitState(['exited'], 45000); // running for 45 s without stopping
    const frames = await page.evaluate(() => Module.kfxFrames || 0);
    const log = await page.evaluate(() => { try { return FS.readFile('/kfx/keeperfx.log', { encoding: 'utf8' }); } catch (e) { return ''; } });
    const version = (log.match(/ver (\d+\.\d+\.\d+\.\d+)/) || [])[1];
    if (s !== 'running') fail(`the game stopped (state ${s})`);
    if (frames < 100) fail(`only ${frames} frames in 45 s`);
    if (!/level 1/i.test(log) && !/Level load timing/.test(log)) fail('the level did not load');
    console.log(`${buildId}: running, ${frames} frames, reports version ${version}`);
  } else {
    console.log(`${buildId}: loaded, data list read, waiting for DK files (state ${s})`);
  }
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
} catch (e) {
  fail(e.message);
} finally {
  await browser.close();
}
