import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';
const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const server = await createServer({ configFile: 'vite.config.mjs', server: { port: 5199, host: process.env.HOST } });
await server.listen();
log('vite listening');
const env = { ...process.env, VITE_DEV_SERVER_URL: server.resolvedUrls.local[0], PC_DEV_DATA_DIR: process.argv[2] };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, ['.', '--remote-debugging-port=9334'], { stdio: 'inherit', env });
// Poll the renderer until the app shell (sidebar) is rendered.
for (;;) {
  await new Promise((r) => setTimeout(r, 300));
  try {
    const targets = await (await fetch('http://127.0.0.1:9334/json')).json();
    const p = targets.find((x) => x.type === 'page' && x.url.startsWith('http'));
    if (!p) continue;
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    const res = await new Promise((r) => {
      ws.onmessage = (m) => r(JSON.parse(m.data));
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: "JSON.stringify({nav: !!document.querySelector('nav a'), res: performance.getEntriesByType('resource').length, load: Math.round(performance.getEntriesByType('navigation')[0]?.loadEventEnd||0)})" } }));
    });
    ws.close();
    const v = JSON.parse(res.result.result.value);
    if (v.nav) { log(`app shell rendered (modules requested: ${v.res}, page load event at ${v.load} ms)`); break; }
  } catch { /* not up yet */ }
}
child.kill();
await server.close();
process.exit(0);
