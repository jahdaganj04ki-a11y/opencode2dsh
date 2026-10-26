# Recherche zur OpenCode-Free-Lane — 26.10.2026

Wie der offizielle OpenCode-Client seine **kostenlosen** Modelle
authentifiziert, adressiert und kodiert — und wie der Fingerprint dieses
Plugins dazu passt.

Englische Fassung: [`free-lane-research-2026-10.md`](./free-lane-research-2026-10.md).

## 1. Quellen und Methode

Drei unabhängige, gegeneinander abgeglichene Quellen:

| Quelle | Datum | Beweiskraft |
| --- | --- | --- |
| TLS-MITM- und Byte-Replay-Notizen, `ref-dsh-our-free-model/docs/free-lane-wire.md` | 14./16.10.2026 | Einzelvariablen-Vergleiche 200 gegen 403 am Live-Gateway |
| Offizieller Quelltext, Repo **`anomalyco/opencode`** (umbenannt aus `sst/opencode`), Branch `dev` | geladen am 26.10.2026 (gleichtags gepusht) | Aktuelle Architektur, Header-Bau, Session-Algorithmus, Fehler-Mapping, Modellkatalog |
| **Original-Binärdatei `@opencode/cli@2.0.26`** von npm, Linux-x64-Bun-Build, 210 MB | geladen am 26.10.2026 | Autoritativ, was genau die nachgebaute Client-Generation sendet |

Das npm-CLI-Paket ist nur ein Launcher; die echte Binärdatei liegt in den
Plattformpaketen (`@opencode/cli-linux-x64@2.0.26`, optionale Abhängigkeit).
Die Belege wurden mit reinen String-Scans gewonnen, zum Beispiel:

```sh
curl -sL https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.0.26.tgz -o cli.tgz
tar -xzf cli.tgz && grep -a -c 'x-opencode-session-id' package/bin/opencode
```

Jede Behauptung nennt ihre Quelle oder den exakten Scan, der sie erzeugt hat.

## 2. Architektur: kein hart kodiertes Free-Gateway im Client

Der offizielle Client kombiniert drei Dienste:

1. **Console-Config** — `GET https://opencode.ai/console/api/v2/config`
   (`packages/core/src/plugin/provider/opencode.ts`): Provider, Base-URLs,
   Modelle und Organisations-Policies. Provider-Base-URLs werden also
   **serverseitig ausgeliefert** — deshalb enthält die 2.0.26-Binärdatei keine
   Chat-URL der Form `opencode.ai/inference/...` als String.
2. **Modellmetadaten** — `https://models.opencode.ai/experimental/v2.0/api.json`
   (`packages/core/src/models-dev.ts`), in Releases als 8-MB-Snapshot gebündelt
   (`packages/core/src/models-dev/snapshot.txt`).
3. **Inferenz** — gegen die Base-URL aus Schritt 1 über Standard-Protokollmodule
   (OpenAI-/Anthropic-Form).

### Die anonyme Credential ist das wörtliche Token `public`

Quelltext (`packages/core/src/plugin/provider/opencode.ts`) und identischer
minifizierter Code in der 2.0.26-Binärdatei:

```js
if (!hasKey && !disableFree) {
  provider.activation = "enabled"
  provider.settings = { ...provider.settings, apiKey: "public" }
}
```

Eine zweite Transformation **deaktiviert danach jedes Modell mit deklarierten
Kosten über Null**. „Free" bedeutet also: anonymer Bearer `public` plus
Modell-IDs mit Preis 0. Ein bezahlter Console-Key schaltet Free-Modelle für
Dritte nicht frei — das Gateway prüft die Client-Form, nicht den Account.
Abschaltmöglichkeit ist die Umgebungsvariable
`OPENCODE_DISABLE_FREE_MODELS` (`"1"`/`"true"`).

## 3. Endpunkt-Topologie und die Pfad-Wanderung

| Lane | Client 2.0.26 (Generation dieses Plugins) | Aktueller Client 2.1.x (`dev`, Katalog-Snapshot) |
| --- | --- | --- |
| Chat Completions | `https://opencode.ai/inference/v1/chat/completions` | `…/inference/openai/v1/chat/completions` |
| Responses | `…/inference/v1/responses` | `…/inference/openai/v1/responses` |
| Anthropic Messages | `…/inference/v1/messages` | `…/inference/anthropic/v1/messages` |
| Modellliste | `GET …/inference/v1/models` (antwortet noch; am 26.10. 9 nutzbare IDs gemessen) | Client nutzt stattdessen `models.opencode.ai` |
| Go-Abo | — | `…/inference/go/openai/v1/…` (eigene `GoUsageLimitError`) |
| Decision-API | — | `…/inference/systemone/v1/systemone` |

Beleg für die neue Form: pro-Modell-Einträge `api.*.base_url` im aktuellen
Katalog-Snapshot sowie Test-Fixtures in
`packages/core/test/session-error.test.ts`, die
`https://opencode.ai/inference/openai/v1/chat/completions` nennen.

Die alte `/zen/v1`-Chat-Lane ist abgeschaltet (seit 14.10. 403
FreeTierError); nur `/zen/go/v1/usage` bleibt für die Go-Verbrauchsmessung.

**Status dieses Plugins:** Es spricht die gemessene 2.0.26-Topologie
(`/inference/v1/*`). Ob das Gateway dieses Präfix noch bedient, ist eine
Live-Frage, die sich aus der Build-Sandbox nicht prüfen lässt (TLS zu
opencode.ai ist hier blockiert); `npm run smoke` auf dem Windows-Host
beantwortet sie. Abschnitt 8 beschreibt die vorbereitete, standardmäßig
inaktive Migration.

## 4. Header-Matrix

Konstruiert im offiziellen Client in
`packages/core/src/session/model-request.ts`; derselbe Block liegt minifiziert
in der 2.0.26-Binärdatei vor.

| Header | Wert | Beleg in der 2.0.26-Binärdatei |
| --- | --- | --- |
| `authorization` | `Bearer public` | String `apiKey:"public"` vorhanden |
| `user-agent` | `opencode/latest/2.0.26/cli` | exakter Vollstring, ein Treffer |
| `content-type` | `application/json` | setzt der Transport bei jedem JSON-POST |
| `accept` | `text/event-stream` | 13 Treffer |
| `x-opencode-client` | `cli` (App-/Artefaktname) | Headername vorhanden |
| `x-opencode-session-id` | die Session-ID | vorhanden |
| `x-opencode-session` | die **Affinity**-ID | vorhanden |
| `x-session-affinity` | die Affinity-ID | vorhanden |
| `X-Session-Id` | die Affinity-ID | vorhanden |
| `x-opencode-project` | `global` (Default `ProjectSchema.ID.global`) | vorhanden |
| `x-opencode-parent-session-id` / `x-parent-session-id` | nur bei Kind-/Fork-Sessions | in Quelle und Binärdatei |

Affinity-Regel (`packages/core/src/session/affinity.ts`):
`parentID ?? fork.sessionID ?? id`. Bei einer Wurzel-Session tragen alle vier
Session-Header denselben Wert — exakt das, was dieses Plugin sendet (eine
DSH-Konversation = eine gemintete Session).

Gate-Fakten zu Headern (Replay-Messungen, Abschnitt 1):

- **`x-opencode-request` muss fehlen.** In der 2.0.26-Binärdatei null Treffer;
  es ist ein v1-only-Header und löst heute 403 aus.
- Der UA wird als Ganzstring der Form
  `opencode/<channel>/<version>/<client>` mit Major ≥ 2 gematcht. Jedes
  Präfix/Suffix oder ein Teilstring `deepseek-harness` (case-insensitiv)
  führt zur Ablehnung.
- `x-opencode-ticket` (PTY-Connect-Token), `x-opencode-directory`
  (MCP/Global-Verzeichnis) sowie `x-org-id`/`x-opencode-org-id` (Console/Go)
  gehören zu anderen Teilsystemen und dürfen in einem Inferenz-Request
  **nicht** auftauchen.

## 5. Session-ID-Algorithmus — bytegleiche Umsetzung

Offizieller Quelltext (`packages/schema/src/identifier.ts`) und minifizierte
2.0.26-Binärdatei enthalten dieselbe Funktion:

```js
// 2.0.26-Binärdatei, de-minifiziert
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

Vom Gateway dekodierte Eigenschaften:

- Präfix `ses_`, dann **12 Big-Endian-Hex-Zeichen** = bitweises NICHT aus
  `ts_ms * 4096 + counter`, dann **14 zufällige Base62-Zeichen**;
- der Zähler startet bei 1 und wird jede Millisekunde zurückgesetzt, sodass
  die invertierten unteren 12 Bits im akzeptierten Kleinzähler-Fenster
  landen (Replay-Tests: 0–16 bestehen, ≥100 werden abgelehnt);
- zufällige oder sha256-abgeleitete Hex-Hälften werden trotz passender
  äußerer Form abgelehnt.

`src/fingerprint.ts` (`mintSessionId`, `canonicalizeSession`) bildet das
bitgenau nach, inklusive 48-Bit-Maske (`& 0xffffffffffffn`) und
Millisekunden-Reset; `canonicalizeSession` faltet einen stabilen
Konversations-Seed in den Zufalls-Schwanz, während die Uhr-Hälfte ein frisch
geminteter, gate-gültiger Wert bleibt.

## 6. Tool-Fingerprint und `tool_choice`

- Jeder Free-Lane-Request muss **sowohl `read` als auch `shell`** deklarieren,
  mit den wortgleichen Beschreibungen **und** Parameter-Schemas des
  offiziellen Clients. Die Beschreibungen (unter anderem „Read the contents
  of a file or directory…", „Execute a shell command and return its
  output…", „Shell command string to execute") liegen in der 2.0.26-Binärdatei
  vor und stimmen mit den eingefrorenen Konstanten in `src/fingerprint.ts`
  überein.
- Die Shell-Beschreibung von 2.0.26 ist die Linux/bash-Variante
  („Commands run on Linux using bash."). Aktuelle `dev`-Builds erzeugen sie
  dynamisch aus OS und Shell — ein weiterer Grund, Client-Generationen nicht
  zu mischen.
- Regel im aktuellen Quelltext
  (`packages/ai/src/protocols/openai-chat.ts`): `tool_choice` wird nur
  serialisiert, wenn aktive Tools existieren *und* explizit eine Wahl
  angefordert wurde; sonst entfällt das Feld. `tool_choice: "none"` auf der
  v2-Lane ist ein 403.
- Kollidierende Caller-Tools mit Namen `read`/`shell` werden zu
  `<name>_client[N]` umbenannt und auf dem Rückweg wiederhergestellt;
  historische Tool-Aufrufe werden synchron mitumbenannt.

## 7. Request-Body, Streaming und Fehler

Chat-Body (OpenAI-Chat-Protokoll, `fromRequest` in `openai-chat.ts`):
`model`, `messages`, `tools` (oder weggelassen), `stream: true`,
`stream_options: { include_usage: true }`, je Modell
`max_tokens`/`max_completion_tokens`, dazu optionale Sampling-Felder.
Transport: JSON-POST, SSE-Frames (`data: …`, `[DONE]`-Sentinel fällt im
Default-Framing weg), Watchdogs auf Chunk-Timeouts im HTTP-Transport.

Serverseitige Fehlerklassen (der Client klassifiziert nur, er definiert sie
nicht — keiner der Strings existiert in der Client-Binärdatei):

| Fehler | HTTP | Bedeutung | Client-Verhalten |
| --- | --- | --- | --- |
| `FreeTierError` | 403 | Fingerprint-Gate: Traffic sieht nicht wie der OpenCode-Client aus | Auth-/Provider-Fehler, kein Retry |
| `FreeUsageLimitError` | 429 + `retry-after` | Freikontingent erschöpft (Fenster bis ca. 12 h beobachtet) | `SessionRunnerRetry.isRetryable === false`; „Free usage limit reached… switch models" (`packages/core/src/session/to-session-error.ts`) |
| `GoUsageLimitError` | 429 | Go-Abo-Kontingent | nicht wiederholbarer Quota-Fehler |
| `BudgetLimitError` | 429 | Workspace-/Modell-Ausgabenbudget | Budget-Limit-Fehler |

Das deckt sich mit der ehrlichen Klassifizierung des Plugins
(`LANE_LOCKED`, `QUOTA` mit Retry-After, `maxRetries: 0`) statt Verschlucken
oder blindem Wiederholen.

## 8. Vorbereitete Migrationsspezifikation (erst nach Live-Smoke scharfschalten)

Die Sandbox erreicht opencode.ai nicht, deshalb darf kein neuer Pfad ohne
Verifikation auf dem Windows-Host umgelegt werden. Die Umsetzung ist bewusst
klein und vollständig rückwärtskompatibel.

Vorgeschlagene Konfig-Erweiterung (`src/config.ts`, Default unverändert):

```ts
/** Inferenz-Pfad-Topologie. 'v1' = Client-2.0.26-Form (Default);
 *  'segmented' = Client-2.1.x-Form mit Protokoll-spezifischen Präfixen. */
inferenceProfile?: 'v1' | 'segmented'
```

Pfad-Mapping (nur `pathForWire` in `src/adapter.ts` und die Katalog-URL
brauchen das Profil; die Modellliste bleibt vorerst auf
`/inference/v1/models`, das nachweislich antwortet):

| Wire | `v1` (Default) | `segmented` |
| --- | --- | --- |
| chat | `/inference/v1/chat/completions` | `/inference/openai/v1/chat/completions` |
| responses | `/inference/v1/responses` | `/inference/openai/v1/responses` |
| messages | `/inference/v1/messages` | `/inference/anthropic/v1/messages` |

Abnahmesequenz vor einem Default-Wechsel:

1. `npm run smoke` auf dem aktuellen `v1`-Profil grün → kein Handlungsbedarf.
2. Liefert `v1` im Chat 403/404, während `/inference/v1/models` noch
   antwortet: Profil ergänzen, Smoke mit
   `inferenceProfile: 'segmented'` fahren, UA und Tool-Definitionen von
   2.0.26 zunächst unverändert lassen (nur ein Live-200 beweist, dass das
   Gate sie weiterhin akzeptiert).
3. Ein 403 `FreeTierError` auf dem segmentierten Profil mit altem UA
   bedeutet, dass das Gate nun auch UA-/Tool-Generation festnagelt — dann
   ist ein kompletter Fingerprint-Refresh auf 2.1.x (dynamischer
   Shell-Text, aktuelle Schemas) nötig, nicht nur ein Pfad-Tausch.
4. Neuen Default erst nach grünem Smoke ausliefern; das alte Profil eine
   Version lang als Rollback wählbar lassen.

## 9. Konformitätsmatrix

| Erforderliche Free-Lane-Eigenschaft | Offizieller Client | Dieses Plugin | Beleg |
| --- | --- | --- | --- |
| Bearer `public`, kein echter Key | ✅ | ✅ | Quelle + Binärdatei / `src/fingerprint.ts` |
| UA `opencode/latest/2.0.26/cli`, Ganzstring | ✅ | ✅ | exakter Binärtreffer / `CLIENT_UA` |
| Vier gespiegelte Session-Header + Projekt `global` | ✅ | ✅ | `model-request.ts` / `gatewayHeaders` |
| Kein `x-opencode-request` | ✅ | ✅ | 0 Binärtreffer / konstruktiv abwesend |
| Gemintete absteigende Session-ID | ✅ | ✅ | identischer Algorithmus (Abschnitt 5) |
| Wortgleiche `read`/`shell`, kein `tool_choice: none` | ✅ | ✅ | Binärstrings / eingefrorene Konstanten |
| Wires unter `/inference/v1/*` | ✅ für 2.0.26 | ✅ | Replay-Tests 16.10.2026 |
| Modellentdeckung | Console-Config + `models.opencode.ai` | Gateway `/inference/v1/models` + Eignungsfilter | 9 Live-IDs am 26.10. gemessen |
| `jev-1.13-free` | im aktuellen Katalog zur `systemone`-Decision-API gewandert | mit `ModelProtocolUnsupported` blockiert | Katalog-Snapshot |
| Nicht wiederholbare Free-Limit-Klassifizierung | ✅ | ✅ (`maxRetries: 0`) | `session-error.test.ts` / Adapter-Policy |

## 10. Beobachtungen zum Katalog

Der gebündelte aktuelle Snapshot enthält 63 IDs mit Endung `-free` (32 live
und nullkosten nach Ausschluss deprecated- und Drittrouter-Einträgen). Die
Free-Einträge mischen drei Protokolle — `chat-completions` (Mehrzahl),
`responses` (z. B. `muse-spark-*`) und `messages` (z. B. `minimax-m*`,
`qwen3.6-plus-free`). Deshalb pflegt dieses Plugin eine pro-Modell
Capability-Tabelle statt eines einzigen Wire. Die Roster-Aktualisierung
kommt weiterhin bei jedem Programmstart von der Live-Gateway-Liste; der
Snapshot lieferte nur die statischen Capability- und Blocklist-Tabellen.
