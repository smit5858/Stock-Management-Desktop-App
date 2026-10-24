'use strict';

const { nativeTheme } = require('electron');
const settingsFile = require('../settingsFile');

function register(handle, { paths }) {
  handle('prefs:get', () => settingsFile.read(paths.settingsFile).ui, { waitForDb: false });

  handle(
    'prefs:set',
    (partial) => {
      const ui = settingsFile.updateUi(paths.settingsFile, partial);
      nativeTheme.themeSource = ui.theme;
      return ui;
    },
    { waitForDb: false },
  );
}

module.exports = { register };
