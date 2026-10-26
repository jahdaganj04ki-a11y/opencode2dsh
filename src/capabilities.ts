/**
 * Vetted per-model capability table for the OpenCode free lane.
 *
 * The gateway listing (`/inference/v1/models`) discloses an id and nothing
 * else, so every operational fact — which wire protocol answers, whether the
 * model sees images, the context window, the output ceiling, and the selectable
 * reasoning levels — comes from this table. Numbers combine the published
 * model cards / models.dev metadata with the live-lane measurements recorded by
 * the two community DSH integrations that track this gateway
 * (FishBottle7/opencode2dsh and Ebony-Vinyl/dsh-our-free-model), re-checked
 * against the live roster on 2026-10-26.
 *
 * Lookup order: exact-id override → family pattern → conservative default, so
 * a freshly rotated `-free` id still advertises honest, working settings while
 * a known id always gets its individually verified numbers.
 */

export type WireKind = 'chat' | 'responses' | 'messages'

export interface EffortMenu {
  /** Selectable ids, ordered from least to greatest reasoning effort. */
  efforts: string[]
  /** Id selected when the caller names no effort. */
  defaultEffort?: string
  /** Wire value for the "off/disabled" rung; omit when the model cannot stop thinking. */
  offWire?: string
}

export interface ModelCapability {
  /** Endpoint protocol this id answers on. */
  wire: WireKind
  /** Accepts image input on the free lane. */
  vision: boolean
  /** Produces reasoning/thinking content. */
  reasoning: boolean
  /** Maximum combined request+response context in tokens. */
  contextWindow: number
  /** Maximum generation output in tokens. */
  maxOutput: number
  /** Declared, gateway-validated thinking menu; absent for non-reasoning models. */
  effort?: EffortMenu
  /** Human-facing picker name. */
  name: string
  /** Short capability note for the picker description. */
  note?: string
}

/** Ids the listing names free of charge without a `-free` suffix. */
export const ALWAYS_FREE = new Set(['big-pickle', 'union-alpha', 'space-bunny-free'])

/**
 * Never advertised on the chat/responses/messages lanes.
 *
 * `jev-*` is a SystemOne structured-decision model: the chat and responses
 * endpoints answer `400 ModelProtocolUnsupported`, and it produces no prose, so
 * exposing it in a coding-agent picker can only create dead selections.
 */
export const BLOCKLIST: Readonly<Record<string, string>> = {
  'jev-1.13-free': 'SystemOne structured-decision model, no chat/responses/messages protocol',
}

/** Human-facing names for the ids currently in rotation. */
const DISPLAY_NAMES: Record<string, string> = {
  'big-pickle': 'Big Pickle',
  'beam-free': 'Beam 1.0 (Free)',
  'flint-40b-free': 'Flint 40B (Free)',
  'mimo-v2.6-flash-free': 'MiMo V2.6 Flash (Free)',
  'mimo-v2.5-free': 'MiMo V2.5 (Free)',
  'nemotron-3.5-super-vl-free': 'Nemotron 3.5 Super VL (Free)',
  'nemotron-3.5-lightning-free': 'Nemotron 3.5 Lightning (Free)',
  'nemotron-3-ultra-free': 'Nemotron 3 Ultra (Free)',
  'deepseek-v4.1-flash-free': 'DeepSeek V4.1 Flash (Free)',
  'deepseek-v4-flash-free': 'DeepSeek V4 Flash (Free)',
  'glm-5.3-flash-free': 'GLM 5.3 Flash (Free)',
  'space-bunny-free': 'Space Bunny (Free)',
  'union-alpha': 'Union Alpha (Free)',
  'ling-3.0-flash-fin-free': 'Ling 3.0 Flash Fin (Free)',
  'muse-spark-1.3-contributor-free': 'Muse Spark 1.3 (Free, Responses)',
  'muse-spark-1.2-contributor-free': 'Muse Spark 1.2 (Free, Responses)',
}

/**
 * Exact-id overrides — the individually verified settings the task requires.
 * Context/output numbers are the *serving* values where the lane has been
 * measured below the published card (documented per entry).
 */
const EXACT: Record<string, ModelCapability> = {
  // Stealth free id, no thinking menu, multimodal. Lane serves ~256k context.
  'big-pickle': {
    wire: 'chat', vision: true, reasoning: false,
    contextWindow: 262_144, maxOutput: 131_072,
    name: displayName('big-pickle'),
  },

  // Reflection Beam 1.0 501B A23B (open weights, 2026-10-05). Text-only,
  // reasoning model; 1M card, 128k output.
  'beam-free': {
    wire: 'chat', vision: false, reasoning: true,
    contextWindow: 1_048_576, maxOutput: 131_072,
    effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    name: displayName('beam-free'),
  },

  // Recursive Flint 40B (open weights, 2026-10-21): 256k context, 256k output.
  'flint-40b-free': {
    wire: 'chat', vision: false, reasoning: true,
    contextWindow: 262_144, maxOutput: 262_144,
    effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    name: displayName('flint-40b-free'),
  },

  // Xiaomi MiMo V2.6 Flash: vision lane live-verified; thinking cannot be
  // switched off (no `none` rung), so no off entry is advertised.
  'mimo-v2.6-flash-free': {
    wire: 'chat', vision: true, reasoning: true,
    contextWindow: 1_048_576, maxOutput: 131_072,
    effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    name: displayName('mimo-v2.6-flash-free'),
  },
  'mimo-v2.5-free': {
    wire: 'chat', vision: true, reasoning: true,
    contextWindow: 1_048_576, maxOutput: 131_072,
    effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    name: displayName('mimo-v2.5-free'),
  },

  // NVIDIA Nemotron 3.5 Super VL — the VL suffix is the vision-language build.
  // Declared menu includes a real off rung (`none`).
  'nemotron-3.5-super-vl-free': {
    wire: 'chat', vision: true, reasoning: true,
    contextWindow: 1_048_576, maxOutput: 131_072,
    effort: {
      efforts: ['disabled', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'high', offWire: 'none',
    },
    name: displayName('nemotron-3.5-super-vl-free'),
  },
  'nemotron-3.5-lightning-free': {
    wire: 'chat', vision: false, reasoning: true,
    contextWindow: 128_000, maxOutput: 32_768,
    effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    name: displayName('nemotron-3.5-lightning-free'),
  },
  'nemotron-3-ultra-free': {
    wire: 'chat', vision: false, reasoning: true,
    contextWindow: 128_000, maxOutput: 32_768,
    effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    name: displayName('nemotron-3-ultra-free'),
  },

  // DeepSeek V4.1 Flash. Vision accepted on the lane; the free lane stopped
  // serving the card's 1M window (~326k prompt refused upstream, Oct 2026), so
  // 300k is the advertised ceiling — DSH compacts at 0.8×, before the wall.
  // The gateway validates reasoning_effort against the declared set.
  'deepseek-v4.1-flash-free': {
    wire: 'chat', vision: true, reasoning: true,
    contextWindow: 300_000, maxOutput: 384_000,
    effort: {
      efforts: ['disabled', 'low', 'high', 'max'],
      defaultEffort: 'high', offWire: 'none',
    },
    name: displayName('deepseek-v4.1-flash-free'),
    note: 'Serving context 300k on the free lane (card: 1M)',
  },
  'deepseek-v4-flash-free': {
    wire: 'chat', vision: false, reasoning: true,
    contextWindow: 128_000, maxOutput: 64_000,
    effort: {
      efforts: ['disabled', 'low', 'high', 'max'],
      defaultEffort: 'high', offWire: 'none',
    },
    name: displayName('deepseek-v4-flash-free'),
  },

  // Z.ai GLM 5.3 Flash: vision, 1M window. No `none` in the declared set and
  // `none` is not honoured anyway — the menu therefore starts at low.
  'glm-5.3-flash-free': {
    wire: 'chat', vision: true, reasoning: true,
    contextWindow: 1_048_576, maxOutput: 131_072,
    effort: { efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high' },
    name: displayName('glm-5.3-flash-free'),
  },

  // Multimodal reasoning id; declared menu lacks an off rung.
  'space-bunny-free': {
    wire: 'chat', vision: true, reasoning: true,
    contextWindow: 1_048_576, maxOutput: 524_288,
    effort: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
    name: displayName('space-bunny-free'),
  },

  // Anthropic Messages wire (`/inference/v1/messages`), vision, no reasoning
  // menu exposed by this id.
  'union-alpha': {
    wire: 'messages', vision: true, reasoning: false,
    contextWindow: 262_144, maxOutput: 131_072,
    name: displayName('union-alpha'),
  },

  'ling-3.0-flash-fin-free': {
    wire: 'chat', vision: false, reasoning: true,
    contextWindow: 128_000, maxOutput: 32_768,
    effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    name: displayName('ling-3.0-flash-fin-free'),
  },

  // Muse Spark only answers on the Responses endpoint; chat answers 500.
  'muse-spark-1.3-contributor-free': {
    wire: 'responses', vision: true, reasoning: true,
    contextWindow: 1_048_576, maxOutput: 131_072,
    effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    name: displayName('muse-spark-1.3-contributor-free'),
  },
  'muse-spark-1.2-contributor-free': {
    wire: 'responses', vision: true, reasoning: true,
    contextWindow: 1_048_576, maxOutput: 131_072,
    effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    name: displayName('muse-spark-1.2-contributor-free'),
  },
}

interface FamilyPattern {
  match: RegExp
  capability: Omit<ModelCapability, 'name'>
}

/** Family defaults for rotated-in ids without an exact entry. */
const FAMILIES: FamilyPattern[] = [
  {
    match: /^muse[-.]?spark/,
    capability: {
      wire: 'responses', vision: true, reasoning: true,
      contextWindow: 1_048_576, maxOutput: 131_072,
      effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    },
  },
  {
    match: /^mimo/,
    capability: {
      wire: 'chat', vision: true, reasoning: true,
      contextWindow: 262_144, maxOutput: 131_072,
      effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    },
  },
  {
    match: /^nemotron/,
    capability: {
      wire: 'chat', vision: false, reasoning: true,
      contextWindow: 128_000, maxOutput: 32_768,
      effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    },
  },
  {
    match: /^(ling|hy3)/,
    capability: {
      wire: 'chat', vision: false, reasoning: true,
      contextWindow: 128_000, maxOutput: 32_768,
      effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    },
  },
  {
    match: /^space[-.]?bunny/,
    capability: {
      wire: 'chat', vision: true, reasoning: true,
      contextWindow: 262_144, maxOutput: 65_536,
      effort: { efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
    },
  },
  {
    match: /^union/,
    capability: {
      wire: 'messages', vision: true, reasoning: false,
      contextWindow: 262_144, maxOutput: 131_072,
    },
  },
  {
    match: /^deepseek/,
    capability: {
      wire: 'chat', vision: false, reasoning: true,
      contextWindow: 128_000, maxOutput: 64_000,
      effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    },
  },
  {
    match: /^glm/,
    capability: {
      wire: 'chat', vision: false, reasoning: true,
      contextWindow: 128_000, maxOutput: 32_768,
      effort: { efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
    },
  },
  {
    match: /^beam/,
    capability: {
      wire: 'chat', vision: false, reasoning: true,
      contextWindow: 1_048_576, maxOutput: 131_072,
      effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    },
  },
  {
    match: /^flint/,
    capability: {
      wire: 'chat', vision: false, reasoning: true,
      contextWindow: 262_144, maxOutput: 262_144,
      effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
    },
  },
]

/** Conservative fallback for a completely unknown `-free` id. */
const DEFAULT_CAPABILITY: Omit<ModelCapability, 'name'> = {
  wire: 'chat',
  vision: false,
  reasoning: true,
  contextWindow: 128_000,
  maxOutput: 32_768,
  effort: { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' },
}

/** Strip a trailing " (level)" suffix and surrounding whitespace. */
export function baseModelId(model: string): string {
  return String(model ?? '').replace(/\([^()]+\)\s*$/, '').trim()
}

function titleCase(id: string): string {
  return id
    .replace(/[-_.]+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}

export function displayName(id: string): string {
  return DISPLAY_NAMES[id] ?? titleCase(id)
}

/**
 * Resolve the full capability record for one model id.
 * Always returns a usable record; unknown ids get the conservative default.
 */
export function capabilitiesFor(id: string): ModelCapability {
  const base = baseModelId(id)
  const exact = EXACT[base]
  if (exact) return { ...exact, name: exact.name ?? displayName(base) }
  for (const family of FAMILIES) {
    if (family.match.test(base)) {
      return { ...family.capability, name: displayName(base) }
    }
  }
  return { ...DEFAULT_CAPABILITY, name: displayName(base) }
}

/** Is this id part of the free lane (name rule plus the suffix-less free ids)? */
export function isFreeId(id: string): boolean {
  const base = baseModelId(id)
  if (ALWAYS_FREE.has(base)) return true
  return /(?:^|[-_])free(?:$|[-_.])/.test(base)
}

/** Blocklist reason, or undefined when the id may be advertised. */
export function blockReason(id: string): string | undefined {
  return BLOCKLIST[baseModelId(id)]
}

/** True when the model accepts image input. */
export function isVisionModel(id: string): boolean {
  return capabilitiesFor(id).vision
}
