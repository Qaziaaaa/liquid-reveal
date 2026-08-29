/* Builds the three dist artefacts from the ESM source (src/liquid-reveal.js):
   - dist/index.mjs      ESM bundle — placeholder assets stay external
                         (resolved via import.meta.url, so they load from
                         <pkg>/assets/*.png at runtime).
   - dist/index.cjs      CJS bundle — placeholders inlined as data: URLs so
                         require() consumers are fully self-contained.
   - dist/index.min.js   minified IIFE exposing the `LiquidReveal` global,
                         same inlined placeholders, for <script> tags.

   The CJS/IIFE builds run through the `inlinePlaceholders` plugin which rewrites
   the two literal placeholder paths in the source to data: URLs, so those
   formats need no asset files and never touch import.meta at runtime.
*/
import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataUrl = (name) => {
  const file = path.join(root, 'assets', name);
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
};

const srcFile = path.join(root, 'src', 'liquid-reveal.js');

const inlinePlaceholders = {
  name: 'inline-placeholders',
  setup(build) {
    build.onLoad({ filter: /liquid-reveal\.js$/ }, async (args) => {
      let text = readFileSync(args.path, 'utf8');
      text = text.replace(
        "'../assets/base-placeholder.png'",
        JSON.stringify(dataUrl('base-placeholder.png'))
      );
      text = text.replace(
        "'../assets/chrome-placeholder.png'",
        JSON.stringify(dataUrl('chrome-placeholder.png'))
      );
      return { contents: text, loader: 'js' };
    });
  },
};

const shared = {
  entryPoints: [srcFile],
  bundle: true,
  target: ['es2020'],
  sourcemap: true,
  logLevel: 'info',
};

await esbuild.build({ ...shared, outfile: 'dist/index.mjs', format: 'esm' });
await esbuild.build({
  ...shared,
  outfile: 'dist/index.cjs',
  format: 'cjs',
  plugins: [inlinePlaceholders],
});
await esbuild.build({
  ...shared,
  outfile: 'dist/index.min.js',
  format: 'iife',
  globalName: 'LiquidReveal',
  minify: true,
  plugins: [inlinePlaceholders],
  footer: {
    js: `(function(){var ns=globalThis.LiquidReveal;if(ns&&ns.default){var C=ns.default;C.DEFAULT_PARAMS=ns.DEFAULT_PARAMS;C.VERSION=ns.VERSION;globalThis.LiquidReveal=C;}})();`,
  },
});