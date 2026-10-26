# opencode2dsh

**OpenCode's kostenlose Modelle im DSH Desktop** (DeepSeek Harness) nutzen –
ohne API-Key, ohne Zusatzprozess, ohne Sidecar. Dieses Plugin ist ein
in sich abgeschlossener Cordis-LLM-Adapter: Es spricht die anonyme
Free-Lane von OpenCode mit exakt dem Client-Fingerprint, den das Gateway
verlangt, und zeigt jedes Modell mit seinen individuell geprüften
Einstellungen (Wire-Protokoll, Vision, Kontextfenster, Output-Limit,
Reasoning-Menü).

- **Zielhost:** DSH Desktop `v0.12.1` (Windows x64), Harness
  `@deepseek-ai/dsh@0.2.1-rc.2`.
- **Laufzeitform:** ein esbuild-Bundle (`dist/index.js`, ca. 80 KB), **keine
  Laufzeitabhängigkeiten** und keine `@deepseek-ai/*`-Importe – der Host
  validiert Adapter strukturell, das Bundle installiert daher sauber in die
  gehoistete pnpm-Generation des Plugin-Managers.
- **Lizenz:** MIT.

> Englische Fassung: [`README.md`](./README.md).

---

## Warum es dieses Plugin braucht

Das OpenCode-Gateway bedient kostenlose Modelle nur, wenn der Traffic wie der
eigene v2-CLI-Client aussieht. Eine gewöhnliche Anfrage – selbst mit einem
bezahlten Console-API-Key – bekommt:

```json
{ "error": { "type": "FreeTierError",
  "message": "OpenCode's free tier can only be used from within OpenCode …" } }
```

Das Plugin bildet den kompletten aktuellen v2-Client-Shape ab (Gate-Stand
Oktober 2026), vollständig im Prozess:

1. Endpunkt unter `/inference/v1/*` (die alte `/zen`-Lane ist für den
   kostenlosen Chat abgeschaltet).
2. `User-Agent: opencode/latest/2.0.26/cli`, **allein** gesendet – jeder
   Präfix/Suffix oder ein `deepseek-harness`-Teilstring führt zur Ablehnung.
3. Eine kanonische `ses_…`-Sitzungs-ID, gespiegelt über vier Session-Header,
   mit der vorgeschriebenen absteigenden Zeitstempel-Codierung
   (`~(ts_ms << 12 | counter)`, Zähler 1–63).
4. Die wortgetreuen offiziellen `read`- und `shell`-Tool-Definitionen;
   kollidierende Caller-Tools werden umbenannt (`<name>_client[N]`) und auf
   dem Rückweg wiederhergestellt.
5. Niemals `tool_choice: "none"`; auf der Responses-Wire wird `auto` verwendet.
6. Anonymer Bearer `public`; kein `x-opencode-request`-Header.

---

## Installation

### Aus einem Tarball (empfohlen unter Windows)

```powershell
npm run build
npm pack
# erzeugt opencode2dsh-0.1.0.tgz – neben DSH Desktop kopieren, dann:
dsh plugin --profile web add .\opencode2dsh-0.1.0.tgz
```

DSH Desktop neu starten. Im Modell-Picker erscheint der Provider
**OpenCode Free**. Entfernen:
`dsh plugin --profile web remove opencode2dsh`.

### Über den Plugin-Markt / Paketnamen

Wenn das Paket in einer für den DSH-Marktinstaller erreichbaren Registry
liegt, kann es wie gewohnt per Paketname installiert werden. Die Zeile aus
`cordis.patch.yml` (`id: opencode-free`, `name: 'opencode2dsh'`) wird
automatisch über die `dsh.bundle.patch`-Deklaration in `package.json`
angewandt.

### Was der Installer tut

Der DSH-Plugin-Manager staget das Paket in einer Content-Hash-Generation unter
`$DSH_HOME/profiles/.generations/live/` mit `node-linker=hoisted`, entfernt
React-/`@deepseek-ai/*`-Singletons und fügt die Cordis-Zeile ein. Dieses
Plugin hat keine Installskripte und keine Laufzeitabhängigkeiten – die
Generation enthält nur das Bundle.

---

## Modelle

Das Gateway-Listing verrät nur IDs; alle Betriebswerte unten stammen aus der
geprüften Fähigkeitstabelle in `src/capabilities.ts` (Model-Cards,
models.dev-Metadaten und Live-Lane-Messungen, am 26.10.2026 gegen das
Live-Roster abgeglichen). Unbekannte rotierte IDs fallen auf Familienmuster
und dann auf konservative Standardwerte zurück, sodass ein frisch
eingestelltes `-free`-Modell sofort funktioniert, während eine bekannte ID
stets ihre individuell verifizierten Werte erhält.

| Modell-ID | Wire | Vision | Kontextfenster | Max. Output | Reasoning-Menü (Standard fett) |
|---|---|---|---|---|---|
| `big-pickle` | chat | ja | 262.144 | 131.072 | – |
| `beam-free` | chat | nein | 1.048.576 | 131.072 | minimal, low, medium, **medium**, high |
| `flint-40b-free` | chat | nein | 262.144 | 262.144 | minimal, low, medium, **medium**, high |
| `mimo-v2.6-flash-free` | chat | ja | 1.048.576 | 131.072 | minimal, low, medium, **medium**, high |
| `nemotron-3.5-super-vl-free` | chat | ja | 1.048.576 | 131.072 | **disabled→`none`**, minimal, low, medium, **high**, xhigh |
| `nemotron-3.5-lightning-free` | chat | nein | 128.000 | 32.768 | minimal, low, medium, **medium**, high |
| `deepseek-v4.1-flash-free` | chat | ja | 300.000 ¹ | 384.000 | **disabled→`none`**, low, **high**, max |
| `glm-5.3-flash-free` | chat | ja | 1.048.576 | 131.072 | low, medium, **high**, max ² |

¹ Die Free-Lane serviert das 1-M-Kontextfenster der Model-Card nicht mehr
(Prompts um 326k wurden im Oktober 2026 upstream abgelehnt); 300k ist die
beworbene Obergrenze, und DSH kompaktiert bei 0,8× – vor der Wand.
² GLM ignoriert `reasoning_effort`; das Plugin sendet stattdessen
`thinking:{type:'enabled'}` plus `output_config.effort`.

Bewusst ausgeblendet:

- `jev-1.13-free` – ein SystemOne-Entscheidungsmodell. Die Chat- und
  Responses-Endpunkte antworten mit `400 ModelProtocolUnsupported`, und es
  erzeugt keinen Fließtext – eine Anzeige wäre nur eine tote Auswahl.

Die Responses-Wire (`/inference/v1/responses`) und die Anthropic-Messages-Wire
(`/inference/v1/messages`) sind vollständig implementiert für rotierte IDs,
die dort antworten (z. B. `muse-spark-*` → responses, `union-*` → messages),
inklusive Stream-Übersetzung, Tool-Pairing und Signatur-Replay.

---

## Konfiguration

Alle Felder sind optional; Validierung mit Fallback bedeutet, dass ein
manuell editiertes Patch die Komposition nicht abstürzen lässt. Overrides
laufen über den `config`-Block in `cordis.patch.yml`, z. B.
`config: { allowedModels: ['beam-free'] }`.

| Feld | Standard | Bedeutung |
|---|---|---|
| `providerId` | `opencode-free` | Provider-Routen-ID im Modell-Picker. |
| `baseUrl` | `https://opencode.ai` | Gateway-Ursprung (nur Mirrors/Tests). |
| `refreshSeconds` | `300` | Katalog-Aktualisierung (30 s – 24 h). |
| `warmMs` | `4000` | Begrenzte Wartezeit auf das erste Live-Listing in `listModels`. |
| `allowedModels` | `[]` | Allowlist exakter IDs; leer zeigt alle zulässigen Freimodelle. |
| `firstEventMs` | `30000` | Watchdog: ms bis zum ersten Stream-Ereignis. |
| `bodyIdleMs` | `120000` | Watchdog: Stille im Stream bei chat/messages. |
| `responsesBodyIdleMs` | `300000` | Stille auf der burstigen Responses-Wire. |
| `diskCache` | `true` | Katalog-Cache und Health-Snapshot persistieren. |
| `dataDir` | – | Datenverzeichnis überschreiben (Tests/portable Setups). |

### Zustand auf der Festplatte

Alles liegt unter `$DSH_HOME/opencode2dsh/` (bzw.
`~/.dsh/opencode2dsh/`), atomar geschrieben (Temp-Datei + Rename) und
best-effort – ein schreibgeschütztes Profil verschlechtert den Cache, niemals
den Provider:

- `catalog-cache.json` – das letzte Live-Listing (7 Tage TTL).
- `adapter-status.json` – Health-Snapshot (`ready` / `stale` /
  `bootstrapping` / `error`, Anzahl sichtbarer Modelle, letzter Fehler).

---

## Wie eine Runde funktioniert

1. **Katalog – immer aktuell, bei jedem Programmstart aktualisiert.** Sobald
   das Plugin geladen ist, holt es `/inference/v1/models`; schlägt dieser
   erste Abruf fehl, wiederholt er es nach kurzem Backoff (1 s, 2 s, 4 s,
   8 s, 15 s, 30 s), bis die erste Live-Antwort da ist, und aktualisiert
   danach alle `refreshSeconds`. Der Picker wartet maximal `warmMs` und
   antwortet dann aus Live → Festplatten-Cache → eingebautem Static-Roster,
   blockiert also nie. Sobald sich der zulässige Live-Roster tatsächlich
   ändert, kündigt das Plugin den Adapter neu an (`handle.replace` →
   Host-Event `llm/adapters-updated`); das macht den gecachten Roster im
   Client ungültig, und jeder Modell-Picker liest `listModels()` automatisch
   neu – ohne Neustart. Freinamen-Regel, Blocklist, Allowlist und
   Deduplizierung greifen an einer Stelle (der Host lehnt Kataloge mit
   doppelten IDs ab).
2. **Request-Aufbau.** Harness-Nachrichten werden in die Wire des Modells
   konvertiert (Chat Completions / Responses / Messages). Tool-Call-/Tool-
   Result-Paare werden vorher repariert (Waisenresultate und unterbrochene
   Calls werden aufgefüllt, damit strikte Upstreams nicht mit 400 antworten).
   Bilder werden über den DSH-Attachment-Service (bzw. die
   `$DSH_HOME/attachments/...`-Konvention) aufgelöst, als Base64 eingebettet
   mit einer 8-MB-Obergrenze; zu große oder bereits ausgelagerte Bilder lösen
   `IMAGE_OFFLOAD_REQUIRED` aus, damit der Host sie auslagern kann.
3. **Fingerprint + Effort.** Das Pflichtpaar `read`/`shell` wird mit
   byte-exakten Definitionen injiziert; der Reasoning-Effort wird pro Familie
   gepatcht (`reasoning_effort`, GLMs `thinking`/`output_config`, verschachteltes
   `reasoning` bei Responses, Token-Budgets bei Anthropic). Die „Aus"-Stufe
   wird nur gesendet, wo das Modell Denken wirklich abschalten kann.
4. **Transport.** Ein POST, SSE gestreamt mit zwei Watchdogs. Nicht-2xx-
   Antworten werden klassifiziert: `FreeTierError`/`RegionError` sind final,
   429 trägt `Retry-After`, 5xx/Verbindungsfehler sind retrybar. HTML-
   Interstitials und Nicht-Stream-JSON-Hüllen werden explizit behandelt.
5. **Runden-Engine (max. zwei Versuche).** Ein retrybarer Transportfehler
   wiederholt Versuch eins nur, solange noch nichts emittiert wurde. Ein
   stiller Reasoning-only-Stopp oder ein Längen-Schnitt mit bereits
   vorhandenem Antworttext löst genau eine tool-freie Fortsetzung aus, wenn
   das Kontextbudget reicht; Usage wird über die Versuche summiert, und das
   terminierende Finish folgt auf den Usage-Chunk.

### An den Harness gemeldete Fehler

`LANE_LOCKED` (Free-Tier-Gate), `REGION_BLOCKED`, `QUOTA_EXCEEDED` (mit
Retry-After), `UNKNOWN_MODEL`, `CONTEXT_WINDOW_EXCEEDED`,
`IMAGE_OFFLOAD_REQUIRED`, `UNSUPPORTED_CONTENT`, `INVALID_CREDENTIAL`,
`EMPTY_RESPONSE`, `STREAM_CLOSED`, `STREAM_TIMEOUT`, `ABORTED`.

---

## Deployment prüfen

Auf einem Rechner mit normalem Internetweg (dem Zielhost des Plugins), in
einem Checkout mit installierten Dev-Abhängigkeiten:

```powershell
npm run smoke
# oder gegen einen Mirror:
npm run smoke -- https://your-mirror.example
```

Das Skript holt das Listing, zeigt die zulässigen Modelle mit ihren
aufgelösten Fähigkeiten, fährt eine echte fingerprintierte Chat-Runde und
danach eine Negativkontrolle, die beweist, dass eine Harness-ähnliche UA
abgelehnt wird. Es nutzt exakt die ausgelieferten Module
(`src/fingerprint.ts`, `src/http.ts`, `src/stream.ts`).

---

## Fehlerbehebung

| Symptom | Ursache / Aktion |
|---|---|
| Jedes Modell liefert Free-Tier-/`LANE_LOCKED`-Fehler | Der Gateway-Fingerprint wurde upstream geändert oder das Netzwerk schreibt TLS/UA um. `adapter-status.json` prüfen, `npm run smoke` ausführen, Plugin aktualisieren. |
| Gelegentlich 403/429, auch bei offiziellen Clients | Bekannte Gateway-Instabilität und sitzungsbezogenes Freikontingent. Das Plugin meldet ehrlich und beachtet `Retry-After`; eine neue Harness-Konversation erzeugt eine frische Upstream-Sitzung. |
| Regionsmeldung | Die Free-Lane lehnt manche Regionen an der Kontokante ab; clientseitig nicht änderbar. |
| Bildnachricht verlangt Auslagerung | Anhang über 8 MB, bereits ausgelagert oder ohne Host-Pfad. Der Host-Offload-Fluss greift automatisch. |
| Empty response / stream closed | Das Gateway beendete ohne Inhalt (`EMPTY_RESPONSE`) oder ohne Terminal-Ereignis (`STREAM_CLOSED`). Retrybare Transportfehler werden automatisch einmal wiederholt. |
| Picker zeigt nach dem Start das Static-Roster | Das Live-Listing war nicht innerhalb `warmMs` erreichbar; der Startup-Backoff wiederholt die Abrufe (maximal alle 30 s), und sobald eine Live-Antwort eintrifft, aktualisiert sich der Picker von selbst. Bei späteren Starts dient der Festplatten-Cache bis zum ersten Frisch-Abruf. |

### Ehrliche Grenzen

- Der Fingerprint ist aus dem Gateway-Verhalten nachgebaut und kann
  veralten, wenn OpenCode sein Gate ändert; die betroffene Fläche ist auf
  `src/fingerprint.ts` und die Version in `CLIENT_UA` begrenzt.
- Kein lokaler Delegations-/Sidecar-Modus: Das Plugin ist bewusst
  prozessintern. Wenn das Gateway anonyme Zugriffe von einem Rechner dauerhaft
  verweigert, kann kein reiner Header-Client das reparieren.
- Freikontingent und Verfügbarkeit werden upstream gesteuert und können sich
  ohne Vorankündigung ändern; Fähigkeitstabelle und Static-Roster sind
  datierte Schnappschüsse.

---

## Entwicklung

```powershell
npm install
npm run typecheck   # striktes TypeScript, noUncheckedIndexedAccess
npm test            # node:test + tsx, 35 Tests (Wires, Fingerprint, Engine)
npm run build       # esbuild → dist/index.js (einzelnes ESM-Bundle, keine Deps)
npm run smoke       # Live-Gateway-Check, braucht echten Internet-Egress
```

Quellstruktur:

| Modul | Verantwortung |
|---|---|
| `src/index.ts` | Cordis-Plugin-Einstieg, Adapter-Registrierung/Entsorgung. |
| `src/adapter.ts` | LlmAdapter-Oberfläche, Zwei-Versuch-Rundenengine, Fehlermapping. |
| `src/catalog.ts` | Live-Listing, Warm-up, Cache, Static-Fallback, Health-Datei. |
| `src/capabilities.ts` | Pro-Modell-Fähigkeitstabelle, Familien-Fallbacks, Blocklist. |
| `src/fingerprint.ts` | v2-Sitzungs-Minting, Header, Tool-Fingerprint, Aliase. |
| `src/http.ts` | POST/SSE-Transport, Watchdogs, Fehlerklassifizierung. |
| `src/messages.ts` | Drei-Wire-Nachrichtenkonvertierung, Pairing-Reparatur, Bilder. |
| `src/stream.ts` | SSE → indizierte Harness-Blöcke für alle drei Wires, Usage. |
| `src/effort.ts` | Reasoning-Menüs und familien­spezifische Effort-Patches. |
| `src/store.ts` / `src/config.ts` / `src/types.ts` | Persistenz, Validierung, struktureller Host-Vertrag. |
