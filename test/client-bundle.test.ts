import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { build } from 'esbuild'
import vm from 'node:vm'

/**
 * Builds the browser half in-memory with the same flags the release build
 * uses (scripts/build-client.mjs) and asserts the ModuleLoader contract and
 * the bundle purity rules, so a regression cannot reach the packed tarball.
 */
async function buildClient(): Promise<string> {
  const result = await build({
    entryPoints: ['src/client/index.ts'],
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: ['es2020'],
    write: false,
    external: ['react'],
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: {
      js:
        'window.__ModuleLoader__.load({ id: "opencode2dsh", factory: (require) => {\n'
        + 'var module = { exports: {} }; var exports = module.exports;',
    },
    footer: { js: 'return module.exports; } });' },
  })
  const file = result.outputFiles[0]
  assert.ok(file, 'esbuild must emit one client artifact')
  return file.text
}

test('client bundle is a single-file ModuleLoader factory', async () => {
  const text = await buildClient()
  assert.match(text, /^window\.__ModuleLoader__\.load\(\{ id: "opencode2dsh", factory: \(require\) => \{/)
  assert.ok(text.trimEnd().endsWith('return module.exports; } });'))
  // The CJS shim and the loader factory are both present exactly once.
  assert.equal((text.match(/window\.__ModuleLoader__\.load/g) ?? []).length, 1)
  assert.match(text, /var module = \{ exports: \{\} \}; var exports = module\.exports;/)
})

test('client bundle keeps react external and imports no @deepseek-ai package', async () => {
  const text = await buildClient()
  assert.match(text, /require\("react"\)/)
  assert.doesNotMatch(text, /@deepseek-ai\//)
  // No other bare require may reach the artifact: everything else is inlined.
  const requires = [...text.matchAll(/require\(("|')([^"']+)\1\)/g)].map((match) => match[2])
  assert.deepEqual([...new Set(requires)], ['react'])
})

test('client bundle registers the settings section and the two bridge calls', async () => {
  const text = await buildClient()
  assert.match(text, /settings\.section/)
  assert.match(text, /id: "opencode2dsh"|id: 'opencode2dsh'/)
  assert.match(text, /api\/opencode2dsh/)
  assert.match(text, /\/status/)
  assert.match(text, /\/refresh/)
})

test('client bundle carries both English and German UI copy', async () => {
  const text = await buildClient()
  assert.match(text, /Refresh model list/)
  assert.match(text, /Modellliste aktualisieren/)
  assert.match(text, /OpenCode free models/)
  assert.match(text, /OpenCode Free-Modelle/)
})

test('released dist/client.js, when built, satisfies the same wrapper contract', () => {
  // The npm build runs before pack; this only checks the artifact if a build
  // has happened, so `npm test` on a clean checkout stays green.
  if (!existsSync('dist/client.js')) return
  const text = readFileSync('dist/client.js', 'utf8')
  assert.match(text, /^window\.__ModuleLoader__\.load\(\{ id: "opencode2dsh"/)
  assert.ok(text.trimEnd().endsWith('return module.exports; } });'))
  assert.doesNotMatch(text, /@deepseek-ai\//)
})

test('the bundle activates under ModuleLoader and renders the German card', async () => {
  const text = await buildClient()
  const created: unknown[] = []
  const reactStub = {
    Fragment: Symbol('fragment'),
    createElement: (...args: unknown[]) => {
      created.push(args)
      return { args }
    },
    useState: (initial: unknown) => [initial, () => undefined],
    useEffect: (fn: () => unknown) => {
      fn()
    },
    useCallback: (fn: (...args: never[]) => unknown) => fn,
  }
  let descriptor: { factory: (require: (id: string) => unknown) => {
    name: string
    inject: string[]
    apply: (ctx: unknown) => void
  } } | undefined
  const styleTag = { setAttribute() {}, textContent: '', dataset: {} }
  const fetches: string[] = []
  const sandbox = {
    console,
    URL,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Error,
    Map,
    Set,
    Symbol,
    Promise,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: async (url: string) => {
      fetches.push(url)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          value: { state: 'ready', live: true, total: 9, eligible: ['big-pickle', 'beam-free'], lastFetchAt: Date.now() },
        }),
      }
    },
    document: {
      baseURI: 'http://127.0.0.1:9000/settings',
      documentElement: { lang: 'de-DE' },
      head: { appendChild() {} },
      createElement: () => styleTag,
      querySelector: () => null,
    },
    window: {
      __ModuleLoader__: {
        load(desc: typeof descriptor) {
          descriptor = desc
        },
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(text, sandbox)
  assert.ok(descriptor, 'the bundle must register itself with the ModuleLoader')

  const mod = descriptor!.factory((specifier) => {
    assert.equal(specifier, 'react')
    return reactStub
  })
  assert.equal(mod.name, 'opencode2dsh')
  // Cross-realm arrays do not satisfy deepEqual's prototype check; compare content.
  assert.equal(JSON.stringify(mod.inject), '["slots","locale"]')

  const registrations: Array<{ options: Record<string, unknown>; component: (props?: unknown) => unknown }> = []
  mod.apply({
    effect: (fn: () => unknown) => fn(),
    locale: { register() {} },
    slots: {
      inject: (_name: string, factory: () => () => void) => factory(),
      register: (options: Record<string, unknown>, component: (props?: unknown) => unknown) => {
        registrations.push({ options, component })
        return () => undefined
      },
    },
  })

  assert.equal(registrations.length, 1)
  const registration = registrations[0]!
  assert.equal(registration.options.name, 'settings.section')
  assert.equal(registration.options.id, 'opencode2dsh')
  assert.equal(registration.options.order, 35)
  assert.equal(typeof registration.options.label, 'function')
  assert.equal((registration.options.label as () => string)(), 'OpenCode Free')

  // The slot render returns an element (createElement does not render); the
  // real shell would call the component — do that manually with its props.
  const element = registration.component({}) as { args: Array<unknown> }
  const render = element.args[0] as (props: unknown) => unknown
  render(element.args[1])
  await new Promise((resolve) => setTimeout(resolve, 10))
  const flat = JSON.stringify(created)
  assert.match(flat, /OpenCode Free-Modelle/, 'German locale must drive the rendered copy')
  assert.match(flat, /Modellliste aktualisieren/)
  assert.ok(fetches.some((url) => url.endsWith('/api/opencode2dsh/status')), `status fetch expected, got ${JSON.stringify(fetches)}`)
  assert.match(styleTag.textContent, /oc2dsh-card/, 'the scoped stylesheet is injected once')
})
