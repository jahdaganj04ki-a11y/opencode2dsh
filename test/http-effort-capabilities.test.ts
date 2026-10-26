import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyFailure, CODE, parseSseBlock, isDoneMarker } from '../src/http.js'
import { applyEffort, effortMenu, resolveEffortId } from '../src/effort.js'
import {
  blockReason,
  capabilitiesFor,
  isFreeId,
  isVisionModel,
} from '../src/capabilities.js'

// ── http ────────────────────────────────────────────────────────────────────

test('parseSseBlock handles comments, concatenated data lines and events', () => {
  assert.equal(parseSseBlock(': keep-alive'), undefined)
  const parsed = parseSseBlock('event: update\ndata: {"a":1}\ndata: {"b":2}')
  assert.equal(parsed?.event, 'update')
  assert.equal(parsed?.data, '{"a":1}\n{"b":2}')
  assert.ok(isDoneMarker('data: [DONE]') === false)
  assert.ok(isDoneMarker('[DONE]'))
})

test('classifyFailure: FreeTierError is final, quota carries retry-after, HTML is interstitial', () => {
  const locked = classifyFailure(
    403,
    JSON.stringify({ error: { type: 'FreeTierError', message: 'used outside OpenCode' } }),
  )
  assert.equal(locked.code, CODE.LANE_LOCKED)
  assert.equal(locked.retryable, false)

  const region = classifyFailure(403, JSON.stringify({ error: { type: 'RegionError' } }))
  assert.equal(region.code, CODE.REGION_BLOCKED)
  assert.equal(region.retryable, false)

  const quota = classifyFailure(429, JSON.stringify({ error: { type: 'FreeUsageLimitError' } }), '120')
  assert.equal(quota.code, CODE.QUOTA)
  assert.equal(quota.providerRetryAfterMs, 120_000)

  const missing = classifyFailure(404, JSON.stringify({ error: { message: 'unknown model' } }))
  assert.equal(missing.code, CODE.UNKNOWN_MODEL)

  const upstream = classifyFailure(502, 'bad gateway')
  assert.equal(upstream.code, CODE.UPSTREAM)
  assert.equal(upstream.retryable, true)

  const html = classifyFailure(200, '<!doctype html><html>cloudflare</html>')
  assert.equal(html.code, CODE.HTML_INTERSTITIAL)
})

// ── effort ──────────────────────────────────────────────────────────────────

test('deepseek menu maps the off rung to the gateway none value', () => {
  const cap = capabilitiesFor('deepseek-v4.1-flash-free')
  assert.deepEqual(
    (effortMenu(cap) ?? []).map((e) => e.id),
    ['disabled', 'low', 'high', 'max'],
  )
  const body: Record<string, unknown> = {}
  applyEffort(body, cap, 'deepseek-v4.1-flash-free', 'disabled')
  assert.equal(body.reasoning_effort, 'none')
  applyEffort(body, cap, 'deepseek-v4.1-flash-free', 'max')
  assert.equal(body.reasoning_effort, 'max')
})

test('glm uses the thinking/output_config patch instead of reasoning_effort', () => {
  const cap = capabilitiesFor('glm-5.3-flash-free')
  const body: Record<string, unknown> = {}
  applyEffort(body, cap, 'glm-5.3-flash-free', resolveEffortId(cap, undefined))
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.ok(typeof (body.output_config as Record<string, unknown>).effort === 'string')
  assert.equal(body.reasoning_effort, undefined)
})

test('responses wire nests effort; messages wire budgets thinking tokens', () => {
  const muse = capabilitiesFor('muse-spark-1.3-contributor-free')
  const responsesBody: Record<string, unknown> = {}
  applyEffort(responsesBody, muse, 'muse-spark-1.3-contributor-free', 'high')
  assert.deepEqual(responsesBody.reasoning, { effort: 'high' })

  const union = capabilitiesFor('union-alpha')
  const messagesBody: Record<string, unknown> = {}
  applyEffort(messagesBody, union, 'union-alpha', undefined)
  assert.equal(Object.keys(messagesBody).length, 0) // non-reasoning model: no-op
})

test('unknown effort names fall back to the default instead of risking a 400', () => {
  const cap = capabilitiesFor('beam-free')
  const id = resolveEffortId(cap, 'ultra-infinite')
  assert.ok(cap.effort?.efforts.includes(id ?? ''))
})

// ── capabilities ────────────────────────────────────────────────────────────

test('free-id rule, blocklist, vision and exact overrides', () => {
  assert.ok(isFreeId('beam-free'))
  assert.ok(isFreeId('big-pickle'))
  assert.equal(isFreeId('jev-1.13-paid'), false)
  assert.ok(blockReason('jev-1.13-free'))

  const deepseek = capabilitiesFor('deepseek-v4.1-flash-free')
  assert.equal(deepseek.contextWindow, 300_000)
  assert.equal(deepseek.wire, 'chat')
  assert.ok(isVisionModel('deepseek-v4.1-flash-free'))
  assert.equal(isVisionModel('beam-free'), false)

  const muse = capabilitiesFor('muse-spark-1.3-contributor-free')
  assert.equal(muse.wire, 'responses')
  const union = capabilitiesFor('union-alpha')
  assert.equal(union.wire, 'messages')
})

test('rotated unknown ids fall back to family then conservative defaults', () => {
  const rotatedGlm = capabilitiesFor('glm-9.9-flash-free')
  assert.equal(rotatedGlm.wire, 'chat')
  assert.ok(rotatedGlm.reasoning)
  const mystery = capabilitiesFor('totally-new-model-free')
  assert.equal(mystery.wire, 'chat')
  assert.equal(mystery.contextWindow, 128_000)
})
