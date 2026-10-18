// Starts the Vite dev server, then Electron pointed at it. Closing Electron stops Vite.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

const server = await createServer({ configFile: 'vite.config.mjs' });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`Vite dev server: ${url}`);

const env = { ...process.env, VITE_DEV_SERVER_URL: url };
delete env.ELECTRON_RUN_AS_NODE; // set by some editors' terminals; would start Electron as plain Node

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
