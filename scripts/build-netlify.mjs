// Bundles the API into one file for Netlify Functions. Netlify's Node runtime can be older than the
// release that lets CommonJS packages require ESM-only ones (content-disposition, set-cookie-parser),
// so everything is resolved here at build time instead. Native or file-reading packages stay external.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/src/netlify.ts'],
  outfile: 'server/dist-netlify/netlify.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external: ['sharp', 'passkit-generator', 'pg', 'pg-native'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
console.log('Built server/dist-netlify/netlify.mjs');
