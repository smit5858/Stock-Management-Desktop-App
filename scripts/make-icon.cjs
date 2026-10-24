// Renders src/assets/default-logo.svg to PNGs and build/icon.ico using Electron itself
// (no extra tools). Run: npm run make-icon   (or: electron scripts/make-icon.cjs path/to/logo.svg)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const src = path.resolve(process.argv[2] || path.join(root, 'src', 'assets', 'default-logo.svg'));
const SIZES = [16, 24, 32, 48, 64, 128, 256];

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'make-icon-')));
app.disableHardwareAcceleration();

/** ICO with embedded PNG images (supported since Windows Vista). */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(src, 'utf8');
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="256" height="256"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });

  const pngs = SIZES.map((size) => ({
    size,
    data: (size === 256
      ? image
      : image.resize({ width: size, height: size, quality: 'best' })
    ).toPNG(),
  }));

  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.mkdirSync(path.join(root, 'electron', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), buildIco(pngs));
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), pngs.at(-1).data);
  fs.writeFileSync(path.join(root, 'electron', 'assets', 'icon.png'), pngs.at(-1).data);
  console.log('Wrote build/icon.ico, build/icon.png, electron/assets/icon.png');
  app.exit(0);
});
