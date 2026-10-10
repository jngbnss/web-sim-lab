/**
 * Menu artwork: a studio shot of every F1 team's car (the game's own model and
 * livery, ?carshot=<id>), saved as transparent WebP to public/menu/cars/<id>.webp.
 *
 *   npm run build && npx tsx scripts/render-cars.ts
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CAR_SPECS } from '../src/vehicle/catalog/specs';

const port = Number(process.env.SHOT_PORT ?? 4181);
const cdpPort = Number(process.env.CDP_PORT ?? 9334);
const out = 'public/menu/cars';
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
  const profile = mkdtempSync(join(tmpdir(), 'web-sim-lab-cars-'));
  const chrome = spawn(browser, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1200,800', '--ignore-gpu-blocklist', 'about:blank']);
  try {
    await waitFor(`http://localhost:${port}/`);
    const targets = (await (await waitFor(`http://127.0.0.1:${cdpPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const cdp = await connect(page.webSocketDebuggerUrl);
    for (const spec of CAR_SPECS) {
      await cdp.send('Page.navigate', { url: `http://localhost:${port}/?carshot=${spec.id}` });
      let ready = false;
      for (let i = 0; i < 150 && !ready; i++) {
        await sleep(200);
        const r = await cdp.send('Runtime.evaluate', { expression: '!!window.carShotReady', returnByValue: true });
        ready = r.result?.result?.value === true;
      }
      if (!ready) throw new Error(`${spec.id}: no render`);
      const r = await cdp.send('Runtime.evaluate', { expression: "document.querySelector('canvas').toDataURL('image/webp', 0.86)", returnByValue: true });
      const data = String(r.result?.result?.value ?? '').replace(/^data:image\/webp;base64,/, '');
      const file = join(out, `${spec.id}.webp`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`saved ${file} (${Math.round(data.length * 0.75 / 1024)} KB)`);
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
