const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Changes the cache location for Puppeteer.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
  browserRevision: '115.0.5763.0',
  // Never download a browser during `yarn install`. CI installs Chromium
  // separately (browser-actions/setup-chrome, pinned to browserRevision
  // above); local/dev machines should point PUPPETEER_EXECUTABLE_PATH at a
  // system Chrome/Chromium instead. This is what keeps `yarn install` fast
  // and failure-free on machines without reliable access to Google's CDN
  // (e.g. WSL).
  skipDownload: true,
};
