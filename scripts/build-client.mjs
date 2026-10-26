/**
 * Build the browser half into dist/client.js.
 *
 * The artifact is a single-file CommonJS bundle wrapped in the shell's
 * ModuleLoader protocol:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { … } })
 *
 * `react` stays external — the shell module table answers it at load time —
 * and every other dependency is inlined (the client source deliberately has
 * none). The node half keeps its own esbuild CLI build (package.json
 * "build:node"), so this script only builds the browser half.
 */
import { build } from 'esbuild'

const ID = 'opencode2dsh'

const result = await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: ['es2020'],
  outfile: 'dist/client.js',
  // The only platform module the client source requires.
  external: ['react'],
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js:
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\n`
      + 'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

// Purity gate: no cross-plugin value import may reach the bundle. Platform
// seeds are external, so any @deepseek-ai specifier here means the source
// broke the collaboration-through-services rule.
for (const file of result.outputFiles ?? []) {
  const text = file.text
  if (/require\(["']@deepseek-ai\//.test(text)) {
    throw new Error('client bundle purity: @deepseek-ai/* value import detected; use cordis services only')
  }
}
