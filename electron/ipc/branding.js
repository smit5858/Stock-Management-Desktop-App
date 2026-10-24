'use strict';

const { dialog, nativeImage } = require('electron');
const dataFiles = require('../dataFiles');
const { AppError } = require('../errors');

function toUrls(paths) {
  const { logo, sound } = dataFiles.getBranding(paths);
  // ?v= busts the cache when a file is replaced under the same name.
  const url = (f) => (f ? `app-data://files/${f.rel}?v=${Math.round(f.mtime)}` : null);
  return { logo_url: url(logo), sound_url: url(sound) };
}

async function pickFile(win, title, exts) {
  const result = await dialog.showOpenDialog(win, {
    title,
    properties: ['openFile'],
    filters: [{ name: exts.join(', ').toUpperCase(), extensions: exts }],
  });
  return result.canceled ? null : result.filePaths[0];
}

function register(handle, { paths, getWindow }) {
  const noDb = { waitForDb: false };

  handle('branding:get', () => toUrls(paths), noDb);

  handle(
    'branding:pickLogo',
    async () => {
      const file = await pickFile(getWindow(), 'Choose a logo', dataFiles.LOGO_EXTS);
      if (file) dataFiles.setLogo(paths, file);
      return toUrls(paths);
    },
    noDb,
  );

  handle(
    'branding:resetLogo',
    () => {
      dataFiles.resetLogo(paths);
      return toUrls(paths);
    },
    noDb,
  );

  handle(
    'branding:pickSound',
    async () => {
      const file = await pickFile(getWindow(), 'Choose a startup sound', dataFiles.SOUND_EXTS);
      if (file) dataFiles.setSound(paths, file);
      return toUrls(paths);
    },
    noDb,
  );

  handle(
    'branding:resetSound',
    () => {
      dataFiles.resetSound(paths);
      return toUrls(paths);
    },
    noDb,
  );

  // The renderer rasterises the logo (SVG included) to PNG; nativeImage cannot read SVG.
  handle(
    'branding:setWindowIcon',
    ({ dataUrl }) => {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
        throw new AppError('Invalid icon image.', 'VALIDATION');
      }
      if (dataUrl.length > 2 * 1024 * 1024)
        throw new AppError('Icon image too large.', 'VALIDATION');
      const image = nativeImage.createFromDataURL(dataUrl);
      if (!image.isEmpty() && getWindow()) getWindow().setIcon(image);
    },
    noDb,
  );
}

module.exports = { register };
