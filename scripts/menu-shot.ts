/**
 * Screenshots of the start menu at a few scroll positions (visual check of the menu),
 * into shots/menu-<n>.png. Optional width x height: MENU_SIZE=390x844 (phone).
 *
 *   npm run build && npx tsx scripts/menu-shot.ts [scrollY ...]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const port = Number(process.env.SHOT_PORT ?? 4182);
const cdpPort = Number(process.env.CDP_PORT ?? 9335);
const out = 'shots';
const [mw, mh] = (process.env.MENU_SIZE ?? '1600x900').split('x').map(Number);
const scrolls = process.argv.slice(2).map(Number);
const browser = [
  process.env.BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
].find((p): p is string => !!p && existsSync(p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url: string): Promise<Response> {
  for (let i = 0; i < 400; i++) {
    try {
      return await fetch(url);
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`no response from ${url}`);
}

async function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map<number, (v: { result?: { result?: { value?: unknown } } }) => void>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as { id?: number };
    if (msg.id !== undefined) pending.get(msg.id)?.(msg as never);
  };
  return {
    send: (method: string, params: object = {}) =>
      new Promise<{ result?: { result?: { value?: unknown } } }>((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    close: () => ws.close(),
  };
}

async function main(): Promise<void> {
  if (!existsSync('dist/index.html')) throw new Error('dist/ missing: run `npm run build` first');
  if (!browser) throw new Error('No Chrome/Edge found; set BROWSER=<path>');
  mkdirSync(out, { recursive: true });
  const viteBin = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');
  const server = spawn(process.execPath, [viteBin, 'preview', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
  const profile = mkdtempSync(join(tmpdir(), 'web-sim-lab-menu-'));
  const chrome = spawn(browser, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', `--window-size=${mw},${mh}`, '--ignore-gpu-blocklist', 'about:blank']);
  try {
    await waitFor(`http://localhost:${port}/`);
    const targets = (await (await waitFor(`http://127.0.0.1:${cdpPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.navigate', { url: `http://localhost:${port}/?menu=&track=monza&car=f1-ferrari` });
    await sleep(5000);
    for (const [n, y] of (scrolls.length ? scrolls : [0]).entries()) {
      await cdp.send('Runtime.evaluate', { expression: `document.querySelector('.menu').scrollTo(0, ${y})` });
      await sleep(600);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = join(out, `menu-${n}.png`);
      writeFileSync(file, Buffer.from(String((shot.result as unknown as { data: string })?.data ?? ''), 'base64'));
      console.log(`saved ${file}`);
    }
    cdp.close();
  } finally {
    chrome.kill();
    server.kill();
    if (process.platform === 'win32') for (const pid of [server.pid, chrome.pid]) if (pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    setTimeout(() => {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* still locked */
      }
    }, 1500);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
