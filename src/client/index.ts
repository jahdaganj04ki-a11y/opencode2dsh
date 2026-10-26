/**
 * opencode2dsh — browser half (DSH Desktop web shell).
 *
 * Contributes one `settings.section` entry: a small card showing the free
 * models this plugin currently exposes plus a button that forces the host
 * process to re-fetch the OpenCode gateway listing and re-announce the
 * roster. All data rides same-origin `/api/opencode2dsh/*` routes served by
 * the plugin's own loopback bridge (`src/bridge.ts`); there is no Remote
 * binding and no second process.
 *
 * Bundle discipline:
 *  - single-file ModuleLoader artifact, wrapped at build time
 *    (`scripts/build-client.mjs`) in `window.__ModuleLoader__.load(...)`;
 *  - `react` is the only external, answered from the shell module table;
 *  - no value import of any `@deepseek-ai/*` package — collaboration happens
 *    through the `slots` and `locale` cordis services;
 *  - hand-written `React.createElement` (no JSX toolchain) and a local de/en
 *    dictionary with a `<html lang>` fallback, so the card stays bilingual
 *    even on shells whose locale plugin knows no `de` dictionary.
 */

// The tsconfig has no DOM lib; declare the two browser globals this module
// touches. Everything else (fetch, AbortController, setTimeout, console) is
// already supplied by @types/node, which the project compiles against.
interface DocumentLike {
  baseURI: string
  documentElement: { lang: string }
  head: { appendChild(node: unknown): unknown }
  createElement(tag: string): {
    setAttribute(name: string, value: string): void
    textContent: string
    dataset: Record<string, string>
  }
  querySelector(selector: string): unknown
}
declare const document: DocumentLike | undefined

// ── loose structural shapes of the shell services (no host package imports) ─

type ComponentFn = (props?: Record<string, unknown>) => unknown
interface SlotRegistry {
  inject(name: string, factory: () => () => void): () => void
  register(options: Record<string, unknown>, component: ComponentFn): () => void
}
interface LocaleService {
  register?(namespace: string, dict: Record<string, Record<string, string>>): unknown
  getLocale?(): { active?: string } | undefined
  getSnapshot?(): { active?: string } | undefined
  locale?: string
}
interface ClientContext {
  effect(fn: () => void | (() => void), label?: string): unknown
  slots: SlotRegistry
  locale?: LocaleService
}

interface ReactApi {
  createElement: (...args: unknown[]) => unknown
}
const React = require('react') as ReactApi
const h = React.createElement

// ── identity + copy ─────────────────────────────────────────────────────────

export const name = 'opencode2dsh'
export const inject = ['slots', 'locale']

const NS = 'settings.opencode2dsh'
const SECTION_ID = 'opencode2dsh'
const SECTION_ORDER = 35

type DictKey =
  | 'nav' | 'title' | 'intro' | 'refresh' | 'refreshing'
  | 'state.bootstrapping' | 'state.ready' | 'state.stale' | 'state.error'
  | 'countOne' | 'countMany' | 'rosterHeading' | 'lastUpdated' | 'never'
  | 'loadFailed' | 'refreshFailed' | 'gatewayIds'
type Dict = Record<DictKey, string>
const DICTIONARIES: Record<'en' | 'de', Dict> = {
  en: {
    nav: 'OpenCode Free',
    title: 'OpenCode free models',
    intro:
      'Anonymous OpenCode free-lane models, no API key and no extra process. '
      + 'The list refreshes automatically at every start; the button forces a fresh gateway fetch now.',
    refresh: 'Refresh model list',
    refreshing: 'Refreshing…',
    'state.bootstrapping': 'Starting…',
    'state.ready': 'Live',
    'state.stale': 'Cached',
    'state.error': 'Offline',
    countOne: '{n} model available',
    countMany: '{n} models available',
    rosterHeading: 'Available models',
    lastUpdated: 'Last updated: {when}',
    never: 'never',
    loadFailed: 'Cannot reach the plugin backend.',
    refreshFailed: 'Refresh failed: {message}',
    gatewayIds: 'Gateway currently reports {n} ids.',
  },
  de: {
    nav: 'OpenCode Free',
    title: 'OpenCode Free-Modelle',
    intro:
      'Anonyme OpenCode-Free-Lane-Modelle, ohne API-Key und ohne Zusatzprozess. '
      + 'Die Liste wird bei jedem Programmstart automatisch aktualisiert; der Button erzwingt jetzt einen neuen Gateway-Abruf.',
    refresh: 'Modellliste aktualisieren',
    refreshing: 'Aktualisiere…',
    'state.bootstrapping': 'Start…',
    'state.ready': 'Live',
    'state.stale': 'Zwischenspeicher',
    'state.error': 'Offline',
    countOne: '{n} Modell verfügbar',
    countMany: '{n} Modelle verfügbar',
    rosterHeading: 'Verfügbare Modelle',
    lastUpdated: 'Zuletzt aktualisiert: {when}',
    never: 'nie',
    loadFailed: 'Plugin-Backend nicht erreichbar.',
    refreshFailed: 'Aktualisierung fehlgeschlagen: {message}',
    gatewayIds: 'Das Gateway meldet aktuell {n} IDs.',
  },
}

function localeTag(ctx: ClientContext): 'en' | 'de' {
  try {
    const snapshot = ctx.locale?.getLocale?.() ?? ctx.locale?.getSnapshot?.()
    const value = snapshot?.active ?? ctx.locale?.locale
    const fallback = document ? document.documentElement.lang : 'en'
    const tag = typeof value === 'string' ? value : fallback || 'en'
    return tag.toLowerCase().startsWith('de') ? 'de' : 'en'
  } catch {
    return 'en'
  }
}

function pick(ctx: ClientContext): Dict {
  return DICTIONARIES[localeTag(ctx)] ?? DICTIONARIES.en
}

function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? `{${key}}`))
}

// ── same-origin API client ──────────────────────────────────────────────────

interface Snapshot {
  state: 'bootstrapping' | 'ready' | 'stale' | 'error'
  live: boolean
  total: number
  eligible: string[]
  lastError?: string
  etag?: string
  lastFetchAt?: number
}
type RefreshEnvelope =
  | { ok: true; value: Snapshot & { refreshedAt?: number } }
  | { ok: false; code: string; message: string; snapshot?: Snapshot }
type StatusEnvelope = { ok: true; value: Snapshot & { at?: number } }

function apiBase(): string {
  try {
    if (document) return new URL('api/opencode2dsh', document.baseURI).pathname
  } catch {
    // fall through to the root-deployed default
  }
  return '/api/opencode2dsh'
}

async function request(path: string, init: { method?: string; timeout: number }): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), init.timeout)
  try {
    const response = await fetch(`${apiBase()}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      redirect: 'error',
      signal: ctrl.signal,
    })
    const text = await response.text()
    let payload: unknown
    try {
      payload = text === '' ? {} : JSON.parse(text)
    } catch {
      payload = { ok: false, message: text.slice(0, 200) }
    }
    if (!response.ok) {
      const message = (payload as { message?: string; error?: string }).message
        ?? (payload as { error?: string }).error
        ?? `HTTP ${response.status}`
      throw new Error(message)
    }
    return payload
  } finally {
    clearTimeout(timer)
  }
}

// ── stylesheet (theme variables only, so dark/light switching keeps working) ─

const CSS = `
.oc2dsh-card { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; color: var(--dsw-alias-label-primary); font-size: 13px; }
.oc2dsh-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.oc2dsh-title { font-weight: 600; font-size: 14px; color: var(--dsw-alias-label-primary); }
.oc2dsh-pill { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.oc2dsh-pill[data-state="ready"] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.oc2dsh-pill[data-state="error"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.oc2dsh-intro { margin: 0; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.oc2dsh-meta { display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-tertiary); }
.oc2dsh-error { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); }
.oc2dsh-button { align-self: flex-start; padding: 6px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-state-business-primary); color: #fff; font-size: 13px; cursor: pointer; }
.oc2dsh-button:disabled { opacity: 0.6; cursor: default; }
.oc2dsh-roster { margin: 0; padding: 8px 10px; max-height: 220px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.oc2dsh-roster li { list-style: none; padding: 3px 0; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
`

function injectStylesheet(): void {
  try {
    if (!document || document.querySelector(`style[data-plugin="${SECTION_ID}"]`)) return
    const tag = document.createElement('style')
    tag.setAttribute('data-plugin', SECTION_ID)
    tag.dataset.plugin = SECTION_ID
    tag.textContent = CSS
    document.head.appendChild(tag)
  } catch {
    // Styling is cosmetic; never let it break slot activation.
  }
}

// ── card component ──────────────────────────────────────────────────────────

interface CardState {
  snapshot: Snapshot | undefined
  loading: boolean
  refreshing: boolean
  error: string
}

function RefreshCard(props: { ctx: ClientContext }): unknown {
  const ctx = props.ctx
  const dict = pick(ctx)
  const reactHooks = React as unknown as {
    useState: <T>(initial: T) => [T, (value: T | ((prev: T) => T)) => void]
    useEffect: (fn: () => void | (() => void), deps: unknown[]) => void
    useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]) => T
  }
  const [state, setState] = reactHooks.useState<CardState>({
    snapshot: undefined,
    loading: true,
    refreshing: false,
    error: '',
  })

  const loadStatus = reactHooks.useCallback(() => {
    setState((prev) => ({ ...prev, loading: true }))
    request('/status', { timeout: 10_000 })
      .then((payload) => {
        const envelope = payload as StatusEnvelope
        setState({ snapshot: envelope.value, loading: false, refreshing: false, error: '' })
      })
      .catch((error: unknown) => {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      })
  }, [])

  reactHooks.useEffect(() => {
    loadStatus()
  }, [loadStatus])

  const onRefresh = reactHooks.useCallback(() => {
    setState((prev) => ({ ...prev, refreshing: true, error: '' }))
    // The listing fetch can take up to the host-side 15 s timeout; allow headroom.
    request('/refresh', { method: 'POST', timeout: 30_000 })
      .then((payload) => {
        const envelope = payload as RefreshEnvelope
        if (envelope.ok) {
          setState({ snapshot: envelope.value, loading: false, refreshing: false, error: '' })
        } else {
          setState((prev) => ({
            snapshot: envelope.snapshot ?? prev.snapshot,
            loading: false,
            refreshing: false,
            error: fill(dict.refreshFailed, { message: envelope.message }),
          }))
        }
      })
      .catch((error: unknown) => {
        setState((prev) => ({
          ...prev,
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      })
  }, [dict.refreshFailed])

  const snap = state.snapshot
  const stateKey: DictKey = snap ? `state.${snap.state}` as DictKey : 'state.bootstrapping'
  const stateLabel = dict[stateKey] ?? snap?.state ?? ''
  const count = snap?.eligible.length ?? 0
  const when = snap?.lastFetchAt
    ? new Date(snap.lastFetchAt).toLocaleString(localeTag(ctx))
    : dict.never
  const children: unknown[] = [
    h('div', { className: 'oc2dsh-head', key: 'head' },
      h('span', { className: 'oc2dsh-title', key: 'title' }, dict.title),
      h('span', { className: 'oc2dsh-pill', key: 'pill', 'data-state': snap?.state ?? 'bootstrapping' }, stateLabel)),
    h('p', { className: 'oc2dsh-intro', key: 'intro' }, dict.intro),
    h('div', { className: 'oc2dsh-meta', key: 'meta' },
      h('span', { key: 'count' }, fill(count === 1 ? dict.countOne : dict.countMany, { n: count })),
      h('span', { key: 'when' }, fill(dict.lastUpdated, { when })),
      snap
        ? h('span', { key: 'total' }, fill(dict.gatewayIds, { n: snap.total }))
        : null),
  ]
  if (state.error) {
    children.push(h('div', { className: 'oc2dsh-error', key: 'error', role: 'alert' }, state.error))
  }
  children.push(
    h('button', {
      className: 'oc2dsh-button',
      key: 'button',
      type: 'button',
      disabled: state.refreshing || state.loading,
      onClick: onRefresh,
    }, state.refreshing ? dict.refreshing : dict.refresh),
  )
  if (snap && snap.eligible.length > 0) {
    children.push(
      h('div', { key: 'roster' },
        h('div', { className: 'oc2dsh-meta', style: { marginBottom: '6px' } }, dict.rosterHeading),
        h('ul', { className: 'oc2dsh-roster' },
          snap.eligible.map((id) => h('li', { key: id }, id)))),
    )
  } else if (!state.loading && !snap) {
    children.push(h('div', { className: 'oc2dsh-error', key: 'backend' }, dict.loadFailed))
  }
  return h('div', { className: 'oc2dsh-card' }, ...children)
}

// ── fiber entry ─────────────────────────────────────────────────────────────

export function apply(ctx: ClientContext): void {
  injectStylesheet()

  // Best-effort dictionary registration: on shells whose locale plugin has no
  // `de` slot the call is harmless, and rendering always falls back to the
  // local dictionary resolved from the active locale tag.
  try {
    ctx.locale?.register?.(NS, { en: DICTIONARIES.en, de: DICTIONARIES.de })
  } catch {
    // locale service absent or stricter than expected — the local dict covers it.
  }

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: SECTION_ORDER,
    label: () => pick(ctx).nav,
    locale: NS,
  }, () => h(RefreshCard, { ctx }))), 'opencode2dsh: settings section')
}

// The build wrapper (`scripts/build-client.mjs`) emits the same string as the
// ModuleLoader id, so the runtime package name and loader id cannot drift.
export const MODULE_ID = SECTION_ID
