# opencode2dsh

Use **OpenCode's free models inside DSH Desktop** (DeepSeek Harness) — no API
key, no extra process, no sidecar. This is a self-contained Cordis LLM adapter
plugin that speaks OpenCode's anonymous free lane with the exact client
fingerprint the gateway requires, and exposes every model with its own
verified wire protocol, vision support, context window, output ceiling and
reasoning menu.

- **Target host:** DSH Desktop `v0.12.1` (Windows x64), Harness
  `@deepseek-ai/dsh@0.2.1-rc.2`.
- **Runtime shape:** one esbuild bundle (`dist/index.js`, ~80 KB), **zero
  runtime dependencies** and no `@deepseek-ai/*` imports — the host validates
  adapters structurally, so the bundle installs cleanly into the plugin
  manager's hoisted pnpm generation.
- **License:** MIT.

> German version: [`README.de.md`](./README.de.md).

---

## Why this plugin exists

OpenCode's gateway only serves free models to traffic shaped like its own v2
CLI. A plain request — even one carrying a paid Console API key — is answered
with:

```json
{ "error": { "type": "FreeTierError",
  "message": "OpenCode's free tier can only be used from within OpenCode …" } }
```

The plugin reproduces the full current v2 client shape (gate state of
2026-10/26), all in-process:

1. Endpoint under `/inference/v1/*` (the old `/zen` lane is decommissioned for
   free chat).
2. `User-Agent: opencode/latest/2.0.26/cli` sent **alone** — any prefix, suffix
   or `deepseek-harness` substring is rejected.
3. One canonical `ses_…` session id mirrored across four session headers,
   with the required descending-timestamp encoding
   (`~(ts_ms << 12 | counter)`, counter 1–63).
4. The verbatim official `read` and `shell` tool definitions; caller tool
   collisions are renamed (`<name>_client[N]`) and restored on the way back.
5. Never `tool_choice: "none"`; the Responses wire uses `auto`.
6. Anonymous bearer token `public`; no `x-opencode-request` header.

---

## Install

### From a packed tarball (recommended for Windows)

```powershell
npm run build
npm pack
# produces opencode2dsh-0.1.0.tgz — copy it next to DSH Desktop, then:
dsh plugin --profile web add .\opencode2dsh-0.1.0.tgz
```

Restart DSH Desktop. The provider **OpenCode Free** appears in the model
picker. Removal: `dsh plugin --profile web remove opencode2dsh`.

### From the plugin market / a package name

If the package is published to a registry the DSH market installer can reach,
install it by package name exactly as the market UI does. The
`cordis.patch.yml` row (`id: opencode-free`, `name: 'opencode2dsh'`) is applied
automatically through the `dsh.bundle.patch` declaration in `package.json`.

### What the installer does

The DSH plugin manager stages the package in a content-hashed generation under
`$DSH_HOME/profiles/.generations/live/` with `node-linker=hoisted`, strips
React/`@deepseek-ai/*` singletons, and inserts the Cordis row from
`cordis.patch.yml`. This plugin has no install scripts and no runtime
dependencies, so the generation contains only the bundle.

---

## Models

The gateway listing discloses ids only; every operational fact below comes
from the vetted capability table in `src/capabilities.ts` (model cards,
models.dev metadata and live-lane measurements, re-checked against the live
roster on 2026-10-26). Unknown rotated ids fall back to family patterns, then
to conservative defaults, so a freshly rotated `-free` model still works while
a known id always gets its individually verified numbers.

| Model id | Wire | Vision | Context window | Max output | Reasoning menu (default bold) |
|---|---|---|---|---|---|
| `big-pickle` | chat | yes | 262 144 | 131 072 | — |
| `beam-free` | chat | no | 1 048 576 | 131 072 | minimal, low, medium, **medium**, high |
| `flint-40b-free` | chat | no | 262 144 | 262 144 | minimal, low, medium, **medium**, high |
| `mimo-v2.6-flash-free` | chat | yes | 1 048 576 | 131 072 | minimal, low, medium, **medium**, high |
| `nemotron-3.5-super-vl-free` | chat | yes | 1 048 576 | 131 072 | **disabled→`none`**, minimal, low, medium, **high**, xhigh |
| `nemotron-3.5-lightning-free` | chat | no | 128 000 | 32 768 | minimal, low, medium, **medium**, high |
| `deepseek-v4.1-flash-free` | chat | yes | 300 000 ¹ | 384 000 | **disabled→`none`**, low, **high**, max |
| `glm-5.3-flash-free` | chat | yes | 1 048 576 | 131 072 | low, medium, **high**, max ² |

¹ The free lane stopped serving the card's 1 M context (~326k prompts were
refused upstream in October 2026); 300k is the advertised ceiling and DSH
compacts at 0.8×, before the wall.
² GLM ignores `reasoning_effort`; the plugin sends `thinking:{type:'enabled'}`
plus `output_config.effort` instead.

Hidden deliberately:

- `jev-1.13-free` — a SystemOne structured-decision model. The chat and
  responses endpoints answer `400 ModelProtocolUnsupported` and it produces no
  prose, so exposing it would only create dead selections.

The Responses wire (`/inference/v1/responses`) and Anthropic Messages wire
(`/inference/v1/messages`) are fully implemented for rotated ids that answer
there (e.g. `muse-spark-*` → responses, `union-*` → messages), including
stream-event translation, tool-call pairing and signature replay.

---

## Configuration

All fields are optional; validate-and-fallback means a hand-edited patch
cannot crash the composition. Override through the row's `config` block in
`cordis.patch.yml`, e.g. `config: { allowedModels: ['beam-free'] }`.

| Field | Default | Meaning |
|---|---|---|
| `providerId` | `opencode-free` | Provider route id shown in the model picker. |
| `baseUrl` | `https://opencode.ai` | Gateway origin (mirrors/tests only). |
| `refreshSeconds` | `300` | Catalog refresh cadence (30 s – 24 h). |
| `warmMs` | `4000` | Bounded wait for the first live listing inside `listModels`. |
| `allowedModels` | `[]` | Exact-id allowlist; empty exposes every eligible free model. |
| `firstEventMs` | `30000` | Watchdog: ms to the first stream event (also bounds connect + response headers). |
| `bodyIdleMs` | `120000` | Watchdog: mid-stream silence on chat/messages. |
| `responsesBodyIdleMs` | `300000` | Mid-stream silence on the bursty Responses wire. |
| `listTimeoutMs` | `15000` | Deadline for a catalog listing fetch (connect + body). |
| `diskCache` | `true` | Persist catalog cache and health snapshot. |
| `dataDir` | — | Override the data directory (tests/portable setups). |

### On-disk state

Everything lives under `$DSH_HOME/opencode2dsh/` (or `~/.dsh/opencode2dsh/`),
written atomically (temp-file + rename) and best-effort — a read-only profile
degrades the cache, never the provider:

- `catalog-cache.json` — the last live listing (7-day TTL).
- `adapter-status.json` — health snapshot (`ready` / `stale` /
  `bootstrapping` / `error`, exposed count, last error) plus turn metrics:
  total turns, internal retries and continuations, failure counts per code,
  and the last failure with its gateway `requestId`/status for support cases.

---

## How a turn works

1. **Catalog — always current, refreshed at every program start.** As soon as
   the plugin loads it fetches `/inference/v1/models`; if that first fetch
   fails it retries on a short backoff (1 s, 2 s, 4 s, 8 s, 15 s, 30 s) until
   the first live answer arrives, then keeps refreshing every
   `refreshSeconds` (±15 % jitter so desktop installs do not poll in
   lockstep). The picker waits at most `warmMs`, then answers from live
   → disk cache → the baked-in static roster, so it never blocks. Whenever the
   eligible live roster actually changes, the plugin re-announces the adapter
   (`handle.replace` → host event `llm/adapters-updated`), which invalidates
   the client's cached roster and makes every model picker re-read
   `listModels()` automatically — no restart needed. Free-name rule,
   blocklist, allowlist and de-duplication are applied in one place (the host
   rejects catalogs containing duplicate ids). A listing that suddenly exposes
   zero eligible models is treated as a fetch failure: the previous roster is
   kept and retried instead of emptying the picker.
2. **Request build.** Harness messages are converted to the model's wire
   (Chat Completions / Responses / Messages). Tool-call/tool-result pairing is
   repaired first (orphan results and interrupted calls are filled so strict
   upstreams never 400). Images are resolved through the DSH attachment
   service (or the `$DSH_HOME/attachments/...` convention), embedded as
   base64 under an 8 MB ceiling; oversized or offloaded images raise
   `IMAGE_OFFLOAD_REQUIRED` so the host can offload instead.
3. **Fingerprint + effort.** The mandatory `read`/`shell` pair is injected with
   byte-exact definitions; reasoning effort is patched per family
   (`reasoning_effort`, GLM's `thinking`/`output_config`, Responses' nested
   `reasoning`, Anthropic token budgets). The off rung is only sent where the
   model really supports disabling thinking.
4. **Transport.** One POST, SSE streamed with two watchdogs that also bound
   the connect/headers phase, and a separate timeout for catalog fetches.
   Non-2xx answers are classified: `FreeTierError`/`RegionError` are final,
   429 carries `Retry-After`, 5xx/connection faults are retryable. HTML
   interstitials and non-stream JSON envelopes are handled explicitly.
5. **Turn engine (max two attempts).** The adapter declares a host retry
   policy of `maxRetries: 0`, so it is the single retry authority: a
   retryable transport failure repeats attempt one only while nothing has
   been emitted. A silent reasoning-only stop, or a length cut that already
   produced answer text, gets exactly one tool-forbidden continuation when
   the context budget allows; usage is summed across attempts and the
   terminal finish follows the usage chunk. An `UNKNOWN_MODEL` answer
   additionally triggers an immediate catalog refresh, so a delisted id
   disappears from the picker without waiting for the next interval.
6. **Image admission.** `imageRequestTarget` passes intrinsic dimensions
   through and declares the same 8 MB ceiling the serializer enforces,
   keeping host-side admission and request building consistent.

### Error vocabulary surfaced to the harness

`LANE_LOCKED` (free-tier gate), `REGION_BLOCKED`, `QUOTA_EXCEEDED` (with
retry-after), `UNKNOWN_MODEL`, `CONTEXT_WINDOW_EXCEEDED`,
`IMAGE_OFFLOAD_REQUIRED`, `UNSUPPORTED_CONTENT`, `INVALID_CREDENTIAL`,
`EMPTY_RESPONSE`, `STREAM_CLOSED`, `STREAM_TIMEOUT`, `ABORTED`.

---

## Verifying a deployment

On a machine with a normal internet route (the plugin's target host), from a
checkout with dev dependencies installed:

```powershell
npm run smoke
# or against a mirror:
npm run smoke -- https://your-mirror.example
```

The script fetches the listing, prints the eligible models with their
resolved capabilities, runs one real fingerprinted chat turn, and then runs a
negative control proving a harness-looking UA is refused. It uses the exact
shipping modules (`src/fingerprint.ts`, `src/http.ts`, `src/stream.ts`).

---

## Troubleshooting

| Symptom | Likely cause / action |
|---|---|
| Every model returns a free-tier / `LANE_LOCKED` error | The gateway fingerprint changed upstream, or the egress network rewrites TLS/UA. Check `adapter-status.json`, run `npm run smoke`, and update the plugin. |
| Intermittent 403/429 even for official clients | Known gateway instability and per-session free quota. The plugin classifies these honestly and honors `Retry-After`; starting a new harness conversation mints a fresh upstream session. |
| Region message | The free lane refuses some regions at the account edge; no client-side setting changes this. |
| Image message asks to offload | Attachment exceeded 8 MB, was already offloaded, or has no host path. The host's image-offload flow handles it automatically. |
| Empty response / stream closed | The gateway ended without content (`EMPTY_RESPONSE`) or without a terminal event (`STREAM_CLOSED`). Retryable transport faults are retried once automatically. |
| Picker shows the static roster after startup | The live listing could not be reached within `warmMs`; the startup backoff keeps retrying (up to every 30 s) and the picker refreshes itself automatically as soon as a live answer arrives. On later launches the disk cache is used until the first fresh fetch. |

### Known scope and honest limitations

- The fingerprint is reverse-engineered from gateway behaviour and can
  therefore rot when OpenCode changes its gate; the code is organized so the
  affected surface is confined to `src/fingerprint.ts` and the version string
  in `CLIENT_UA`.
- No local delegation/sidecar mode: this plugin is deliberately in-process
  only. If the gateway permanently refuses anonymous traffic from a machine,
  no header-only client can fix that.
- Free-lane quota and availability are controlled upstream and can change
  without notice; the capability table and static roster are dated snapshots.

---

## Development

```powershell
npm install
npm run typecheck   # strict TypeScript, noUncheckedIndexedAccess
npm test            # node:test + tsx, 35 tests (wires, fingerprint, engine)
npm run build       # esbuild → dist/index.js (single ESM bundle, no deps)
npm run smoke       # live gateway check, needs real internet egress
```

Source layout:

| Module | Responsibility |
|---|---|
| `src/index.ts` | Cordis plugin entry, adapter registration/disposal. |
| `src/adapter.ts` | LlmAdapter surface, two-attempt turn engine, failure mapping. |
| `src/catalog.ts` | Live listing, warm-up, cache, static fallback, health file. |
| `src/capabilities.ts` | Per-model capability table, family fallbacks, blocklist. |
| `src/fingerprint.ts` | v2 session minting, headers, tool fingerprint, aliases. |
| `src/http.ts` | POST/SSE transport, watchdogs, failure classification. |
| `src/messages.ts` | Three-wire message conversion, pairing repair, images. |
| `src/stream.ts` | SSE → indexed harness blocks for all three wires, usage. |
| `src/effort.ts` | Reasoning menus and per-family effort field patches. |
| `src/store.ts` / `src/config.ts` / `src/types.ts` | Persistence, validation, structural host contract. |
