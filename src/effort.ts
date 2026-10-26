/**
 * Reasoning-effort resolution and per-wire field patches.
 *
 * The gateway has no single effort convention:
 *  - most chat ids validate a top-level `reasoning_effort` string against a
 *    fixed vocabulary (`none|minimal|low|medium|high|xhigh|max` — an unknown
 *    value is a hard 400);
 *  - GLM-flash ids ignore that field and require `thinking: {type:'enabled'}`
 *    plus `output_config.effort`;
 *  - the Responses wire speaks OpenAI's nested `reasoning: {effort}`;
 *  - the Anthropic Messages wire budgets thinking in tokens
 *    (`thinking: {type:'enabled', budget_tokens}`).
 *
 * Models with a vetted declared menu take the "declared" path: the picker only
 * offers values the gateway actually accepts, including a real off rung mapped
 * through `offWire`. Unknown reasoning ids fall back to a token-budget ladder
 * (light 2048 / balanced 8192 / deep = output capacity), doubled on families
 * that cannot disable thinking — the shape Ebony's free-lane adapter converged
 * on after the October 2026 gateway changes.
 */

import type { ModelCapability } from './capabilities.js'
import type { ReasoningEffortInfo } from './types.js'

const EFFORT_LABELS: Record<string, string> = {
  disabled: 'Off',
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
}

const LADDER_LIGHT = 2048
const LADDER_BALANCED = 8192

export function effortMenu(cap: ModelCapability): ReasoningEffortInfo[] | undefined {
  if (!cap.reasoning || !cap.effort) return undefined
  return cap.effort.efforts.map((id) => ({ id, name: EFFORT_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1) }))
}

/** The menu id that should be sent when the caller names none. */
export function defaultEffortId(cap: ModelCapability): string | undefined {
  if (!cap.reasoning || !cap.effort) return undefined
  if (cap.effort.defaultEffort && cap.effort.efforts.includes(cap.effort.defaultEffort)) {
    return cap.effort.defaultEffort
  }
  return cap.effort.efforts[Math.floor((cap.effort.efforts.length - 1) / 2)]
}

/** Normalize a caller-named effort onto the model's declared menu. */
export function resolveEffortId(cap: ModelCapability, requested: string | undefined): string | undefined {
  if (!cap.reasoning || !cap.effort) return undefined
  if (requested && cap.effort.efforts.includes(requested)) return requested
  return defaultEffortId(cap)
}

/** The gateway-facing value for a menu id (off-rung translation included). */
function wireValue(cap: ModelCapability, menuId: string): string {
  if (menuId === 'disabled' || menuId === 'none') return cap.effort?.offWire ?? 'none'
  return menuId
}

function isGlmFamily(modelId: string): boolean {
  return /^glm/i.test(modelId)
}

/** OpenAI Responses only names low/medium/high; compress the wider menu onto it. */
function responsesEffort(value: string): string {
  if (value === 'none' || value === 'disabled' || value === 'minimal') return 'low'
  if (value === 'xhigh' || value === 'max') return 'high'
  return ['low', 'medium', 'high'].includes(value) ? value : 'medium'
}

function ladderIndex(menu: string[] | undefined, requested: string | undefined): 0 | 1 | 2 {
  const id = requested ?? menu?.[Math.floor((menu.length - 1) / 2)] ?? 'medium'
  if (['disabled', 'none', 'minimal', 'low'].includes(id)) return 0
  if (['xhigh', 'max', 'high'].includes(id)) return 2
  return 1
}

function thinkingBudget(cap: ModelCapability, requested: string | undefined): number {
  const rung = ladderIndex(cap.effort?.efforts, requested)
  const canDisable = Boolean(cap.effort?.offWire)
  const multiplier = canDisable ? 1 : 2
  if (rung === 0) return LADDER_LIGHT * multiplier
  if (rung === 1) return LADDER_BALANCED * multiplier
  return Math.max(LADDER_BALANCED * multiplier, Math.min(cap.maxOutput, 32_768))
}

/**
 * Mutate `body` in place with the effort fields this model/wire expect.
 * No-op for non-reasoning models; an unknown effort name is ignored rather
 * than risking a gateway 400.
 */
export function applyEffort(
  body: Record<string, unknown>,
  cap: ModelCapability,
  modelId: string,
  requested: string | undefined,
): void {
  if (!cap.reasoning) return
  const menuId = resolveEffortId(cap, requested)
  if (!menuId) return
  const value = wireValue(cap, menuId)
  const off = value === 'none'

  if (isGlmFamily(modelId)) {
    // GLM free lane: no `none` honouring; enable thinking and name the effort.
    body.thinking = { type: 'enabled' }
    body.output_config = { effort: value === 'none' ? 'low' : value }
    return
  }

  if (cap.wire === 'responses') {
    if (off && cap.effort?.offWire) {
      body.reasoning = { effort: 'low' } // Responses has no off state; floor it.
    } else {
      body.reasoning = { effort: responsesEffort(value) }
    }
    return
  }

  if (cap.wire === 'messages') {
    if (off) {
      body.thinking = { type: 'disabled' }
    } else {
      body.thinking = { type: 'enabled', budget_tokens: thinkingBudget(cap, requested) }
    }
    return
  }

  // Generic chat wire.
  if (cap.effort) {
    body.reasoning_effort = value
    return
  }
  // Undeclared reasoning id: still send a vocabulary-safe effort string.
  body.reasoning_effort = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? value : 'medium'
}
