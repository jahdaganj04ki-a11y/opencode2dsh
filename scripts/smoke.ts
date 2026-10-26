/**
 * Live gateway smoke check — run on a machine with a normal internet route
 * (the DSH Desktop Windows host, or any node ≥ 20.19):
 *
 *   node --import tsx scripts/smoke.ts [baseUrl]
 *
 * It exercises the exact modules the plugin ships:
 *   1. fetch the live model listing and apply the eligibility rules;
 *   2. mint a v2 session and run one real chat turn with the full fingerprint
 *      (UA, four mirrored session headers, verbatim read/shell tools);
 *   3. negative control — the same traffic with a harness-looking UA must be
 *      refused with FreeTierError, proving the fingerprint is what unlocks the
 *      lane rather than the network path.
 *
 * Exit code 0 means every check the plugin depends on passed.
 */

import { blockReason, capabilitiesFor, isFreeId } from '../src/capabilities.js'
import { fetchListing } from '../src/catalog.js'
import { applyFingerprint, CLIENT_UA, gatewayHeaders, sessionForConversation } from '../src/fingerprint.js'
import { CODE, GatewayFailure, openGatewayStream } from '../src/http.js'
import { feedStream } from '../src/stream.js'
import type { StreamChunk } from '../src/types.js'

const baseUrl = (process.argv[2] ?? 'https://opencode.ai').replace(/\/+$/, '')

function report(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<number> {
  let failures = 0

  // 1. Listing + eligibility.
  let ids: string[] = []
  try {
    ids = await fetchListing(baseUrl)
    report('model listing reachable', ids.length > 0, `${ids.length} ids`)
  } catch (error) {
    report('model listing reachable', false, error instanceof Error ? error.message : String(error))
    return 1
  }
  const eligible = ids.filter((id) => isFreeId(id) && !blockReason(id))
  report('free-id eligibility + blocklist', eligible.length > 0, eligible.join(', '))
  for (const id of eligible) {
    const cap = capabilitiesFor(id)
    console.log(`       - ${id}: wire=${cap.wire} vision=${cap.vision} ctx=${cap.contextWindow} out=${cap.maxOutput} reasoning=${cap.reasoning ? 'yes' : 'no'}`)
  }

  // 2. Real chat turn through the shipped fingerprint + SSE stack.
  const target = eligible.find((id) => capabilitiesFor(id).wire === 'chat') ?? eligible[0]
  if (!target) {
    report('chat turn', false, 'no eligible model')
    return 1
  }
  const session = sessionForConversation(`smoke-${Date.now()}`)
  report('session id is gate-shaped', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(session), session)

  const body: Record<string, unknown> = {
    model: target,
    messages: [{ role: 'user', content: 'Reply with exactly the word: ok' }],
    stream: true,
  }
  const aliases = applyFingerprint(body, 'chat')
  const headers = gatewayHeaders(session)
  const chunks: StreamChunk[] = []
  let turnError: unknown
  try {
    const stream = await openGatewayStream(
      `${baseUrl}/inference/v1/chat/completions`,
      headers,
      body,
      undefined,
      { firstEventMs: 30_000, bodyIdleMs: 120_000 },
    )
    const result = await feedStream('chat', stream.events, aliases, (chunk) => chunks.push(chunk))
    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    const ok = chunks.some((c) => c.type === 'block-start') && result.terminal !== 'error'
    report(`chat turn via ${target}`, ok, `terminal=${result.terminal} text=${JSON.stringify(text.slice(0, 60))}`)
    if (!ok) failures += 1
  } catch (error) {
    turnError = error
    report(`chat turn via ${target}`, false, error instanceof Error ? error.message : String(error))
    failures += 1
  }

  // 3. Negative control: a harness UA must be locked out.
  if (!(turnError instanceof GatewayFailure && turnError.code === CODE.LANE_LOCKED)) {
    try {
      const badHeaders = { ...gatewayHeaders(session), 'user-agent': 'deepseek-harness/9.9 smoke' }
      const probe = await openGatewayStream(
        `${baseUrl}/inference/v1/chat/completions`,
        badHeaders,
        { ...body },
        undefined,
        { firstEventMs: 15_000, bodyIdleMs: 30_000 },
      )
      // Drain; any answer means the gate did not engage.
      for await (const _ of probe.events) void _
      report('negative control (harness UA refused)', false, 'gateway answered a harness UA — fingerprint assumptions changed')
      failures += 1
    } catch (error) {
      const locked = error instanceof GatewayFailure && error.code === CODE.LANE_LOCKED
      report('negative control (harness UA refused)', locked, locked ? 'FreeTierError as expected' : error instanceof Error ? error.message : String(error))
      if (!locked) failures += 1
    }
  }

  console.log(`\nuser-agent sent: ${CLIENT_UA}`)
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  return failures === 0 ? 0 : 1
}

main().then((code) => process.exit(code), (error) => {
  console.error(error)
  process.exit(1)
})
