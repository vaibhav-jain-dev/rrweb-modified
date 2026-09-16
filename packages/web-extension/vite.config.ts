import { defineConfig, LibraryFormats, PluginOption } from 'vite';
import webExtension, { readJsonFile } from 'vite-plugin-web-extension';
import zip from 'vite-plugin-zip-pack';
import * as path from 'path';
import type { PackageJson } from 'type-fest';
import react from '@vitejs/plugin-react';
import semver from 'semver';
import { mergeManifestLayer } from './src/utils/manifest';

const emptyOutDir = !process.argv.includes('--watch');

// `vite-plugin-web-extension` runs several internal vite build() calls
// even during `vite dev` (once per entry group, plus the manifest step),
// and each one re-resolves defineConfig's own `command` argument as
// 'build' rather than inheriting 'serve' from the outer CLI invocation -
// only the manifest-writing step actually saw 'serve'. That mismatch is
// what produced a split output (some files in dist/chrome, the manifest
// expected in dist/chrome-dev) the first time this used `command` instead
// of the CLI subcommand directly. process.argv[2] is set once, by the
// actual `vite dev`/`vite build` invocation, and every nested build()
// call this plugin makes runs inside that same process - so it stays
// correct across all of them.
const isDevServer = process.argv[2] === 'dev';

function useSpecialFormat(
  entriesToUse: string[],
  format: LibraryFormats,
): PluginOption {
  return {
    name: 'use-special-format',
    config(config) {
      // entry can be string | string[] | {[entryAlias: string]: string}
      const entry = config.build?.lib && config.build.lib.entry;
      let shouldUse = false;

      if (typeof entry === 'string') {
        shouldUse = entriesToUse.includes(entry);
      } else if (Array.isArray(entry)) {
        shouldUse = entriesToUse.some((e) => entry.includes(e));
      } else if (entry && typeof entry === 'object') {
        const entryKeys = Object.keys(entry);
        shouldUse = entriesToUse.some((e) => entryKeys.includes(e));
      }

      if (shouldUse) {
        config.build = config.build ?? {};
        // @ts-expect-error: lib needs to be an object, forcing it.
        config.build.lib =
          typeof config.build.lib == 'object' ? config.build.lib : {};
        // @ts-expect-error: lib is an object
        config.build.lib.formats = [format];
      }
    },
  };
}

/**
 * Get the extension version based on the rrweb version.
 */
function getExtensionVersion(rrwebVersion: string): string {
  const parsedVersion = semver.parse(rrwebVersion.replace('^', ''));

  if (!parsedVersion) {
    throw new Error('Invalid version format');
  }

  if (parsedVersion.prerelease.length > 0) {
    // If it's a pre-release version like alpha or beta, strip the pre-release identifier
    return `${parsedVersion.major}.${parsedVersion.minor}.${
      parsedVersion.patch
    }.${parsedVersion.prerelease[1] || 0}`;
  } else if (rrwebVersion === '2.0.0') {
    // This version has already been released as the first version. We need to add a patch version to it to avoid publishing conflicts.
    return '2.0.0.100';
  } else {
    return rrwebVersion;
  }
}

export default defineConfig({
  root: 'src',
  // Configure our outputs - nothing special, this is normal vite config
  build: {
    outDir: path.resolve(
      __dirname,
      'dist',
      // `vite dev` and `vite build` must never share an output directory:
      // a `dist/<browser>` built for production has plain bundled script
      // tags, while dev mode injects HMR client tags pointing at
      // http://localhost:5173, which MV3's CSP blocks outright. Sharing a
      // directory meant loading the extension unpacked could silently
      // pick up a mix of both, depending on which command ran last - a
      // blank popup/options page with cross-world preload errors and CSP
      // violations in the console, no code change required to trigger it.
      // Separate directories make that class of bug impossible instead of
      // relying on remembering to rebuild.
      isDevServer
        ? `${process.env.TARGET_BROWSER as string}-dev`
        : (process.env.TARGET_BROWSER as string),
    ),
    emptyOutDir,
  },
  // Add the webExtension plugin
  plugins: [
    react(),
    webExtension({
      // A function to generate manifest file dynamically.
      manifest: () => {
        const packageJson = readJsonFile('package.json') as PackageJson;
        type ManifestBase = {
          common: Record<string, unknown>;
          chrome: Record<string, unknown>;
          firefox: Record<string, unknown>;
        };
        const originalManifest = readJsonFile('./src/manifest.json') as {
          common: Record<string, unknown>;
          v2: ManifestBase;
          v3: ManifestBase;
        };
        const ManifestVersion =
          process.env.TARGET_BROWSER === 'chrome' ? 'v3' : 'v2';
        const BrowserName =
          process.env.TARGET_BROWSER === 'chrome' ? 'chrome' : 'firefox';
        const commonManifest = originalManifest.common;
        const rrwebVersion = packageJson.dependencies!.rrweb!.replace('^', '');
        const manifest = {
          version: getExtensionVersion(rrwebVersion),
          author: packageJson.author,
          version_name: rrwebVersion,
          ...commonManifest,
        };
        mergeManifestLayer(manifest, originalManifest[ManifestVersion].common);
        mergeManifestLayer(
          manifest,
          originalManifest[ManifestVersion][BrowserName],
        );
        return manifest;
      },
      browser: process.env.TARGET_BROWSER,
      webExtConfig: {
        startUrl: ['github.com/rrweb-io/rrweb'],
        watchIgnored: ['*.md', '*.log'],
      },
      additionalInputs: ['pages/index.html', 'content/inject.ts'],
    }) as PluginOption,
    // https://github.com/aklinker1/vite-plugin-web-extension/issues/50#issuecomment-1317922947
    // transfer inject.ts to iife format to avoid error
    useSpecialFormat(
      [path.resolve(__dirname, 'src/content/inject.ts')],
      'iife',
    ),
    process.env.ZIP === 'true' &&
      zip({
        inDir: `dist/${process.env.TARGET_BROWSER || 'chrome'}`,
        outDir: 'dist',
        outFileName: `${process.env.TARGET_BROWSER || 'chrome'}.zip`,
      }),
  ],
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
    },
  },
});
