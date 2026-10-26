# OpenCode free-lane wire research — 2026-10-26

How the official OpenCode client authenticates, addresses and frames requests
for its **free** models, and how this plugin's fingerprint maps onto it.

German version: [`free-lane-research-2026-10.de.md`](./free-lane-research-2026-10.de.md).

## 1. Sources and method

Three independent sources, cross-checked against each other:

| Source | Date | What it proves |
| --- | --- | --- |
| TLS MITM + byte-level replay notes, `ref-dsh-our-free-model/docs/free-lane-wire.md` | 2026-10-14 / 10-16 | Single-variable 200-vs-403 experiments against the live gateway |
| Official source, repo **`anomalyco/opencode`** (the renamed `sst/opencode`), branch `dev` | fetched 2026-10-26 (pushed the same day) | Current architecture, header construction, session algorithm, error mapping, model catalog |
| **Original client binary `@opencode/cli@2.0.26`** from npm, Linux x64 Bun build, 210 MB | fetched 2026-10-26 | Authoritative evidence of what the exact client generation we mimic actually sends |

The npm CLI package is a launcher; the real binary ships in platform packages
(`@opencode/cli-linux-x64@2.0.26`, optional dependency). Evidence below was
extracted with plain string scans, e.g.

```sh
curl -sL https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.0.26.tgz -o cli.tgz
tar -xzf cli.tgz && grep -a -c 'x-opencode-session-id' package/bin/opencode
```

Nothing in this document relies on memory alone; every claim names its source
or the exact scan that produced it.

## 2. Architecture: no hard-coded free gateway in the client

The official client composes three services:

1. **Console config** — `GET https://opencode.ai/console/api/v2/config`
   (`packages/core/src/plugin/provider/opencode.ts`), supplying providers,
   base URLs, models and organization policy. Provider base URLs are therefore
   **server-delivered**, which is why the 2.0.26 binary contains no
   `opencode.ai/inference/...` chat URL as a string.
2. **Model metadata catalog** — `https://models.opencode.ai/experimental/v2.0/api.json`
   (`packages/core/src/models-dev.ts`), bundled into releases as an 8 MB
   snapshot (`packages/core/src/models-dev/snapshot.txt`).
3. **Inference** — against the base URL from step 1, using standard
   OpenAI/Anthropic protocol modules.

### The anonymous credential is the literal token `public`

Source (`packages/core/src/plugin/provider/opencode.ts`) and the identical
minified code inside the 2.0.26 binary:

```js
if (!hasKey && !disableFree) {
  provider.activation = "enabled"
  provider.settings = { ...provider.settings, apiKey: "public" }
}
```

A second transform then **disables every model whose declared cost is above
zero**. "Free" is therefore: anonymous bearer token `public` + zero-cost model
ids. A paid Console key does not unlock free models for third parties — the
gate distinguishes client shape, not accounts. The kill switch is the
`OPENCODE_DISABLE_FREE_MODELS` environment variable (`"1"`/`"true"`).

## 3. Endpoint topology — and the path migration

| Lane | Client 2.0.26 (this plugin's generation) | Current client 2.1.x (`dev`, catalog snapshot) |
| --- | --- | --- |
| Chat Completions | `https://opencode.ai/inference/v1/chat/completions` | `…/inference/openai/v1/chat/completions` |
| Responses | `…/inference/v1/responses` | `…/inference/openai/v1/responses` |
| Anthropic Messages | `…/inference/v1/messages` | `…/inference/anthropic/v1/messages` |
| Model listing | `GET …/inference/v1/models` (still answering; 9 eligible ids measured 2026-10-26) | client uses `models.opencode.ai` instead |
| Go subscription | — | `…/inference/go/openai/v1/…` (separate `GoUsageLimitError`) |
| Decision API | — | `…/inference/systemone/v1/systemone` |

Evidence for the new shape: per-model `api.*.base_url` entries in the current
catalog snapshot, and test fixtures in
`packages/core/test/session-error.test.ts` naming
`https://opencode.ai/inference/openai/v1/chat/completions`.

The old `/zen/v1` chat lane is decommissioned (403 FreeTierError since
2026-10-14); only `/zen/go/v1/usage` remains, for Go subscription metering.

**Status of this plugin:** it speaks the measured 2.0.26 topology
(`/inference/v1/*`). Whether the gateway still serves that prefix is a
live-gateway question that cannot be tested from the build sandbox (TLS to
opencode.ai is blocked here); `npm run smoke` on the Windows host answers it.
Section 8 specifies the prepared, default-off migration.

## 4. Header matrix

Constructed in the official client at
`packages/core/src/session/model-request.ts`; the same block exists minified
in the 2.0.26 binary.

| Header | Value | 2.0.26 binary evidence |
| --- | --- | --- |
| `authorization` | `Bearer public` | `apiKey:"public"` string present |
| `user-agent` | `opencode/latest/2.0.26/cli` | exact full string found once |
| `content-type` | `application/json` | transport sets it on every JSON POST |
| `accept` | `text/event-stream` | 13 occurrences |
| `x-opencode-client` | `cli` (the app/artifact name) | header name present |
| `x-opencode-session-id` | the session id | present |
| `x-opencode-session` | the **affinity** id | present |
| `x-session-affinity` | the affinity id | present |
| `X-Session-Id` | the affinity id | present |
| `x-opencode-project` | `global` (default `ProjectSchema.ID.global`) | present |
| `x-opencode-parent-session-id` / `x-parent-session-id` | only for child/fork sessions | present in source + binary |

Affinity rule (`packages/core/src/session/affinity.ts`):
`parentID ?? fork.sessionID ?? id`. For a root session all four session
headers therefore carry the same value, which is exactly what this plugin
sends (one DSH conversation → one minted session).

Header gate facts (replay-measured, see section 1):

- **`x-opencode-request` must be absent.** Zero occurrences in the 2.0.26
  binary; it is a v1-only header and its presence now produces 403.
- The UA is whole-string matched as `opencode/<channel>/<version>/<client>`
  with major version ≥ 2. Any prefix, suffix, or a `deepseek-harness`
  substring (case-insensitive) is rejected.
- `x-opencode-ticket` (PTY connect tokens), `x-opencode-directory`
  (MCP/global directory) and `x-org-id` / `x-opencode-org-id` (Console/Go)
  belong to other subsystems and must **not** appear on an inference request.

## 5. Session id algorithm — byte-equivalent implementation

Official source (`packages/schema/src/identifier.ts`) and the minified 2.0.26
binary contain the same function:

```js
// 2.0.26 binary, de-minified
function $J(descending, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) { lastTimestamp = timestamp; counter = 0 }
  counter++
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current
  const time = Array.from({ length: 6 }, (_, i) =>
    Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0")).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(26 - 12))
  return time + Array.from(bytes, (b) => BASE62[b % 62]).join("")
}
// SessionID.create() = "ses_" + descending()
```

Properties the gateway decodes:

- prefix `ses_`, then **12 big-endian hex chars** = bitwise NOT of
  `ts_ms * 4096 + counter`, then **14 random base62 chars**;
- counter starts at 1 and resets every millisecond, so the inverted low 12
  bits land in the accepted small-counter window (replay tests: 0–16 pass,
  ≥100 rejected);
- random or sha256-derived hex halves are rejected even when the outer shape
  matches.

`src/fingerprint.ts` (`mintSessionId`, `canonicalizeSession`) reproduces this
bit for bit, including the 48-bit mask (`& 0xffffffffffffn`) and per-ms
counter reset; `canonicalizeSession` folds a stable conversation seed into the
random tail while keeping the clock half a freshly minted, gate-valid value.

## 6. Tool fingerprint and `tool_choice`

- Every free-lane request must declare **both `read` and `shell`**, with the
  official client's verbatim descriptions **and** parameter schemas. The
  description strings (including "Read the contents of a file or directory…",
  "Execute a shell command and return its output…", "Shell command string to
  execute") are present in the 2.0.26 binary and identical to the frozen
  constants in `src/fingerprint.ts`.
- The 2.0.26 shell description is the Linux/bash variant
  ("Commands run on Linux using bash."). Current `dev` builds it dynamically
  from OS and shell — another reason not to mix client generations.
- Current source rule (`packages/ai/src/protocols/openai-chat.ts`):
  `tool_choice` is serialized **only** when active tools exist *and* a choice
  was explicitly requested; otherwise the field is omitted. Sending
  `tool_choice: "none"` on the v2 lane is a 403.
- Caller tools colliding with `read`/`shell` are renamed to
  `<name>_client[N]` and restored on the way back; history call blocks are
  renamed in lockstep.

## 7. Request body, streaming and errors

Chat body (OpenAI Chat protocol, `fromRequest` in `openai-chat.ts`):
`model`, `messages`, `tools` (or omitted), `stream: true`,
`stream_options: { include_usage: true }`, `max_tokens` /
`max_completion_tokens` per model declaration, plus optional sampling fields.
Transport: JSON POST, SSE frames (`data: …`, `[DONE]` sentinel dropped by the
default framing), chunk-timeout watchdogs in the HTTP transport.

Server-side failure classes (the client only classifies; it does not define
them — neither string exists in the client binary):

| Error | HTTP | Meaning | Client behavior |
| --- | --- | --- | --- |
| `FreeTierError` | 403 | Fingerprint gate: traffic does not look like the OpenCode client | surfaced as auth/provider error; not retried |
| `FreeUsageLimitError` | 429 + `retry-after` | Free quota exhausted (observed windows up to ~12 h) | `SessionRunnerRetry.isRetryable === false`; "Free usage limit reached… switch models" (`packages/core/src/session/to-session-error.ts`) |
| `GoUsageLimitError` | 429 | Go subscription quota | non-retryable quota error |
| `BudgetLimitError` | 429 | Workspace/model spend budget | budget-limit error |

This matches the plugin's honest classification (`LANE_LOCKED`, `QUOTA` with
retry-after, `maxRetries: 0`) rather than swallowing or blindly retrying.

## 8. Prepared migration spec (gated on a live smoke result)

The sandbox cannot reach opencode.ai, so no new path may be flipped on without
a Windows-host verification. The implementation is deliberately small and
fully backward-compatible.

Proposed config addition (`src/config.ts`, default unchanged):

```ts
/** Inference path topology. 'v1' = client 2.0.26 shape (default);
 *  'segmented' = client 2.1.x shape with per-protocol prefixes. */
inferenceProfile?: 'v1' | 'segmented'
```

Path mapping (only `pathForWire` in `src/adapter.ts` and the catalog URL need
the profile; the model listing keeps `/inference/v1/models`, which is
confirmed answering, until a live test proves otherwise):

| Wire | `v1` (default) | `segmented` |
| --- | --- | --- |
| chat | `/inference/v1/chat/completions` | `/inference/openai/v1/chat/completions` |
| responses | `/inference/v1/responses` | `/inference/openai/v1/responses` |
| messages | `/inference/v1/messages` | `/inference/anthropic/v1/messages` |

Acceptance sequence before switching the default:

1. `npm run smoke` green on the current `v1` profile → no action needed.
2. If `v1` returns 403/404 on chat while `/inference/v1/models` still
   answers: add the profile, run smoke with `inferenceProfile: 'segmented'`,
   keep the 2.0.26 UA and tool definitions unchanged (the gateway's client
   recognition may still accept them; only a live 200 proves it).
3. A 403 `FreeTierError` on the segmented profile with the old UA means the
   gate now also pins UA/tool generation — then a full 2.1.x fingerprint
   refresh (dynamic shell text, current schemas) is required, not just a path
   change.
4. Only ship a new default after a green smoke run; leave the old profile
   selectable for one release as a rollback.

## 9. Conformance matrix

| Required free-lane property | Official client | This plugin | Evidence |
| --- | --- | --- | --- |
| Bearer `public`, no real key | ✅ | ✅ | source + binary / `src/fingerprint.ts` |
| UA `opencode/latest/2.0.26/cli`, whole-string | ✅ | ✅ | exact binary match / `CLIENT_UA` |
| Four mirrored session headers + `global` project | ✅ | ✅ | `model-request.ts` / `gatewayHeaders` |
| No `x-opencode-request` | ✅ | ✅ | 0 binary hits / absent by construction |
| Minted descending session id | ✅ | ✅ | identical algorithm (section 5) |
| Verbatim `read`/`shell`, no `tool_choice: none` | ✅ | ✅ | binary strings / frozen constants |
| Wires under `/inference/v1/*` | ✅ for 2.0.26 | ✅ | replay tests 2026-10-16 |
| Model discovery | Console config + `models.opencode.ai` | gateway `/inference/v1/models` + eligibility filter | measured 9 live ids 2026-10-26 |
| `jev-1.13-free` | moved to `systemone` decision API in current catalog | blocklisted with `ModelProtocolUnsupported` | catalog snapshot |
| Non-retryable free-limit classification | ✅ | ✅ (`maxRetries: 0`) | `session-error.test.ts` / adapter policy |

## 10. Catalog observations

The bundled current snapshot contains 63 ids ending in `-free` (32 live,
zero-cost after excluding deprecated and third-party-router entries). Free
entries mix three protocols — `chat-completions` (the majority), `responses`
(e.g. `muse-spark-*`) and `messages` (e.g. `minimax-m*`, `qwen3.6-plus-free`)
— which is why this plugin maintains a per-model capability table rather than
a single wire. Roster freshness still comes from the live gateway listing on
every program start; the snapshot only informed the static capability and
blocklist tables.
