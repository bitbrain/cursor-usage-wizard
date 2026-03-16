/**
 * Model pricing: cents per 1M input tokens and per 1M output tokens.
 * Used for token-based cost estimation (does not account for caching).
 * Sourced from Cursor docs (cursor.com/docs/models) and provider APIs as of 2026.
 */
export interface ModelPricing {
  inputCentsPer1M: number;
  outputCentsPer1M: number;
  /** Wh per 1M combined (input + output) tokens; EcoLogits/ML.ENERGY calibration. */
  energyWh1MTokens: number;
}

/** Default when model is unknown or "auto" (Cursor Auto + Composer pool: cursor.com/docs/models-and-pricing). */
const DEFAULT_PRICING: ModelPricing = {
  inputCentsPer1M: 125,
  outputCentsPer1M: 600,
  energyWh1MTokens: 60,
};

/** Carbon intensity (gCO2/kWh), IEA 2023 global average. */
export const CARBON_INTENSITY_G_PER_KWH = 480;
/** Datacenter water usage effectiveness (L/kWh), conservative global avg. */
export const DATACENTER_WUE_L_PER_KWH = 0.5;

/** Model ID (normalized lowercase) → pricing. Cursor-supported models + common API IDs. */
const MODEL_PRICING: Record<string, ModelPricing> = {
  auto: DEFAULT_PRICING,

  // https://cursor.com/docs/models-and-pricing
  'claude-4-sonnet': { inputCentsPer1M: 300, outputCentsPer1M: 1500, energyWh1MTokens: 80 },
  'claude-4-sonnet-1m': { inputCentsPer1M: 600, outputCentsPer1M: 2250, energyWh1MTokens: 100 },
  'claude-4.5-haiku': { inputCentsPer1M: 100, outputCentsPer1M: 500, energyWh1MTokens: 46 },
  'claude-4-5-haiku': { inputCentsPer1M: 100, outputCentsPer1M: 500, energyWh1MTokens: 46 },
  'claude-4.5-opus': { inputCentsPer1M: 500, outputCentsPer1M: 2500, energyWh1MTokens: 155 },
  'claude-4-5-opus': { inputCentsPer1M: 500, outputCentsPer1M: 2500, energyWh1MTokens: 155 },
  'claude-4.5-sonnet': { inputCentsPer1M: 300, outputCentsPer1M: 1500, energyWh1MTokens: 80 },
  'claude-4-5-sonnet': { inputCentsPer1M: 300, outputCentsPer1M: 1500, energyWh1MTokens: 80 },
  'claude-4.6-opus': { inputCentsPer1M: 500, outputCentsPer1M: 2500, energyWh1MTokens: 155 },
  'claude-4-6-opus': { inputCentsPer1M: 500, outputCentsPer1M: 2500, energyWh1MTokens: 155 },
  'claude-4.6-opus-fast': { inputCentsPer1M: 3000, outputCentsPer1M: 15000, energyWh1MTokens: 155 },
  'claude-4.6-sonnet': { inputCentsPer1M: 300, outputCentsPer1M: 1500, energyWh1MTokens: 80 },
  'claude-4-6-sonnet': { inputCentsPer1M: 300, outputCentsPer1M: 1500, energyWh1MTokens: 80 },
  'claude-opus-4.6': { inputCentsPer1M: 500, outputCentsPer1M: 2500, energyWh1MTokens: 155 },
  'claude-sonnet-4.6': { inputCentsPer1M: 300, outputCentsPer1M: 1500, energyWh1MTokens: 80 },
  'claude-opus-4.5': { inputCentsPer1M: 500, outputCentsPer1M: 2500, energyWh1MTokens: 155 },
  'claude-sonnet-4.5': { inputCentsPer1M: 300, outputCentsPer1M: 1500, energyWh1MTokens: 80 },
  'claude-haiku-4.5': { inputCentsPer1M: 100, outputCentsPer1M: 500, energyWh1MTokens: 46 },

  // Cursor Composer
  'composer-1': { inputCentsPer1M: 125, outputCentsPer1M: 1000, energyWh1MTokens: 70 },
  'composer-1.5': { inputCentsPer1M: 350, outputCentsPer1M: 1750, energyWh1MTokens: 80 },
  'composer-1-5': { inputCentsPer1M: 350, outputCentsPer1M: 1750, energyWh1MTokens: 80 },

  // Google Gemini — Flash ~46, Pro ~90
  'gemini-2.5-flash': { inputCentsPer1M: 30, outputCentsPer1M: 250, energyWh1MTokens: 46 },
  'gemini-2-5-flash': { inputCentsPer1M: 30, outputCentsPer1M: 250, energyWh1MTokens: 46 },
  'gemini-3-flash': { inputCentsPer1M: 50, outputCentsPer1M: 300, energyWh1MTokens: 46 },
  'gemini-3-pro': { inputCentsPer1M: 200, outputCentsPer1M: 1200, energyWh1MTokens: 90 },
  'gemini-3-1-pro': { inputCentsPer1M: 200, outputCentsPer1M: 1200, energyWh1MTokens: 90 },
  'gemini-3-pro-image-preview': { inputCentsPer1M: 200, outputCentsPer1M: 1200, energyWh1MTokens: 90 },
  'gemini-3-1-pro-image-preview': { inputCentsPer1M: 200, outputCentsPer1M: 1200, energyWh1MTokens: 90 },
  'gemini-3.1-pro': { inputCentsPer1M: 200, outputCentsPer1M: 1200, energyWh1MTokens: 90 },

  // OpenAI GPT-5 family — mini ~46, full ~90
  'gpt-5': { inputCentsPer1M: 125, outputCentsPer1M: 1000, energyWh1MTokens: 90 },
  'gpt-5-fast': { inputCentsPer1M: 250, outputCentsPer1M: 2000, energyWh1MTokens: 90 },
  'gpt-5-mini': { inputCentsPer1M: 25, outputCentsPer1M: 200, energyWh1MTokens: 46 },
  'gpt-5.4': { inputCentsPer1M: 250, outputCentsPer1M: 1500, energyWh1MTokens: 90 },
  'gpt-5-4': { inputCentsPer1M: 250, outputCentsPer1M: 1500, energyWh1MTokens: 90 },
  'gpt-5.2': { inputCentsPer1M: 175, outputCentsPer1M: 1400, energyWh1MTokens: 90 },
  'gpt-5-2': { inputCentsPer1M: 175, outputCentsPer1M: 1400, energyWh1MTokens: 90 },
  'gpt-5-codex': { inputCentsPer1M: 125, outputCentsPer1M: 1000, energyWh1MTokens: 90 },
  'gpt-5.1-codex': { inputCentsPer1M: 125, outputCentsPer1M: 1000, energyWh1MTokens: 90 },
  'gpt-5.1-codex-max': { inputCentsPer1M: 125, outputCentsPer1M: 1000, energyWh1MTokens: 90 },
  'gpt-5.1-codex-mini': { inputCentsPer1M: 25, outputCentsPer1M: 200, energyWh1MTokens: 46 },
  'gpt-5.2-codex': { inputCentsPer1M: 175, outputCentsPer1M: 1400, energyWh1MTokens: 90 },
  'gpt-5.3-codex': { inputCentsPer1M: 175, outputCentsPer1M: 1400, energyWh1MTokens: 90 },

  // xAI Grok
  'grok-code': { inputCentsPer1M: 20, outputCentsPer1M: 150, energyWh1MTokens: 40 },

  // Moonshot Kimi (32B active)
  'kimi-k2.5': { inputCentsPer1M: 60, outputCentsPer1M: 300, energyWh1MTokens: 55 },
  'kimi-k2-5': { inputCentsPer1M: 60, outputCentsPer1M: 300, energyWh1MTokens: 55 },

  // Legacy OpenAI (still referenced by some hooks)
  'gpt-4o': { inputCentsPer1M: 250, outputCentsPer1M: 1000, energyWh1MTokens: 90 },
  'gpt-4o-mini': { inputCentsPer1M: 15, outputCentsPer1M: 60, energyWh1MTokens: 46 },
  'gpt-4.1': { inputCentsPer1M: 200, outputCentsPer1M: 800, energyWh1MTokens: 80 },
  'gpt-4.1-mini': { inputCentsPer1M: 80, outputCentsPer1M: 320, energyWh1MTokens: 50 },
  'o4-mini': { inputCentsPer1M: 400, outputCentsPer1M: 1600, energyWh1MTokens: 100 },
};

function normalizeModelKey(model: string): string {
  return model
    .toLowerCase()
    .trim()
    .replace(/[/:_]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const MODEL_ALIAS: Record<string, string> = {
  default: 'auto',
};

const TRANSIENT_SUFFIX_TOKENS = new Set([
  // Quality / reasoning flavors commonly appended by Cursor or providers.
  'high',
  'medium',
  'low',
  'thinking',
  'reasoning',
  // Frequent API/runtime wrappers.
  'latest',
  'preview',
  'experimental',
  'exp',
  // Date-like or snapshot-ish final tags are stripped separately too.
  'snapshot',
]);

function stripTrailingDateLikeToken(key: string): string {
  // e.g. ...-20260205, ...-2026-02-05, ...-2026-02
  return key
    .replace(/-\d{8}$/g, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/g, '')
    .replace(/-\d{4}-\d{2}$/g, '');
}

function stripTransientSuffixes(key: string): string {
  let current = key;
  while (true) {
    const parts = current.split('-');
    if (parts.length <= 1) return current;
    const tail = parts[parts.length - 1];
    if (TRANSIENT_SUFFIX_TOKENS.has(tail) || /^\d{8}$/.test(tail)) {
      parts.pop();
      current = parts.join('-');
      continue;
    }
    return current;
  }
}

function getModelKeyCandidates(rawModel: string): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    if (!value || out.includes(value)) return;
    out.push(value);
  };

  const normalized = normalizeModelKey(rawModel || 'auto');
  push(normalized);

  const aliased = MODEL_ALIAS[normalized];
  if (aliased) push(aliased);

  const withoutProvider = normalized.replace(/^(anthropic|openai|google|xai|moonshot)-/, '');
  if (withoutProvider !== normalized) push(withoutProvider);

  const noDate = stripTrailingDateLikeToken(normalized);
  if (noDate !== normalized) push(noDate);

  const stripped = stripTransientSuffixes(noDate);
  if (stripped !== noDate) push(stripped);

  const strippedNoProvider = stripTransientSuffixes(withoutProvider);
  if (strippedNoProvider !== withoutProvider) push(strippedNoProvider);

  // Variant with dots as dashes for IDs that may arrive either form.
  for (const k of [...out]) {
    const dashed = k.replace(/\./g, '-');
    if (dashed !== k) push(dashed);
  }

  return out;
}

function resolveModelPricingKey(model: string | undefined): string {
  const candidates = getModelKeyCandidates(model || 'auto');

  for (const candidate of candidates) {
    if (MODEL_PRICING[candidate] != null) return candidate;
  }

  // Fallback: prefix match so "claude-4.6-opus-high" -> "claude-4.6-opus".
  const knownKeysByLength = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const matched = knownKeysByLength.find(
      (known) => candidate === known || candidate.startsWith(`${known}-`)
    );
    if (matched) return matched;
  }

  return 'auto';
}

/**
 * Get pricing for a model. Returns default for unknown models.
 */
export function getModelPricing(model: string | undefined): ModelPricing {
  const key = resolveModelPricingKey(model);
  return MODEL_PRICING[key] ?? DEFAULT_PRICING;
}

/**
 * Compute cost in cents for given input and output token counts.
 */
export function tokenCostCents(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number
): number {
  const p = getModelPricing(model);
  const inputCents = (inputTokens / 1_000_000) * p.inputCentsPer1M;
  const outputCents = (outputTokens / 1_000_000) * p.outputCentsPer1M;
  return Math.round((inputCents + outputCents) * 100) / 100;
}

/**
 * Compute energy in Wh for given total (input + output) token count.
 * Used for water and CO2 estimates.
 */
export function tokenEnergyWh(
  model: string | undefined,
  totalTokens: number
): number {
  const p = getModelPricing(model);
  return (totalTokens / 1_000_000) * p.energyWh1MTokens;
}
