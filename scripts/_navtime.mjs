import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';
const server = await createServer({ configFile: 'vite.config.mjs' });
await server.listen();
const env = { ...process.env, VITE_DEV_SERVER_URL: server.resolvedUrls.local[0], PC_DEV_DATA_DIR: process.argv[2] };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, ['.', '--remote-debugging-port=9334'], { stdio: 'ignore', env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (;;) {
  await sleep(300);
  try {
    const p = (await (await fetch('http://127.0.0.1:9334/json')).json()).find((x) => x.type === 'page' && x.url.startsWith('http'));
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r)); break; }
  } catch {}
}
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) pend.get(d.id)(d); };
const ev = (expression) => new Promise((r) => { const i = ++id; pend.set(i, (d) => r(d.result.result?.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
while (!(await ev("!!document.querySelector('nav a')"))) await sleep(200);
await sleep(2500); // loader
await ev(`window.__lt = []; new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: false }); 1`);
const pages = ['/billing', '/products', '/purchases', '/parties', '/warranty', '/settings', '/', '/billing', '/products', '/warranty', '/parties', '/'];
for (const p of pages) {
  const ms = await ev(`new Promise((res) => { const t = performance.now(); location.hash = '#${p}'; const check = () => { const h = document.querySelector('main'); if (h && h.innerText.length > 50 && !h.querySelector('.skeleton')) res(Math.round(performance.now() - t)); else requestAnimationFrame(check); }; setTimeout(check, 0); setTimeout(() => res('timeout'), 15000); })`);
  const lt = await ev('JSON.stringify(window.__lt.splice(0))');
  console.log(p.padEnd(10), String(ms).padStart(6), 'ms   long tasks:', lt);
  await sleep(400);
}
console.log('heap MB', await ev('Math.round(performance.memory.usedJSHeapSize/1e6)'));
child.kill(); await server.close(); process.exit(0);
