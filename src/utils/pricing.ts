/**
 * Model pricing: cents per 1M input tokens and per 1M output tokens.
 * Used for token-based cost estimation (does not account for caching).
 * Sourced from Cursor docs (cursor.com/docs/models) and provider APIs as of 2026.
 */
export interface ModelPricing {
  inputCentsPer1M: number;
  outputCentsPer1M: number;
}

/** Default when model is unknown or "auto" (Cursor Auto/Composer-like tier). */
const DEFAULT_PRICING: ModelPricing = {
  inputCentsPer1M: 250,
  outputCentsPer1M: 1500,
};

/** Model ID (normalized lowercase) → pricing. Cursor-supported models + common API IDs. */
const MODEL_PRICING: Record<string, ModelPricing> = {
  auto: DEFAULT_PRICING,

  // Anthropic Claude
  'claude-4-sonnet': { inputCentsPer1M: 300, outputCentsPer1M: 1500 },
  'claude-4-sonnet-1m': { inputCentsPer1M: 600, outputCentsPer1M: 2250 },
  'claude-4.5-haiku': { inputCentsPer1M: 100, outputCentsPer1M: 500 },
  'claude-4-5-haiku': { inputCentsPer1M: 100, outputCentsPer1M: 500 },
  'claude-4.5-opus': { inputCentsPer1M: 500, outputCentsPer1M: 2500 },
  'claude-4-5-opus': { inputCentsPer1M: 500, outputCentsPer1M: 2500 },
  'claude-4.5-sonnet': { inputCentsPer1M: 300, outputCentsPer1M: 1500 },
  'claude-4-5-sonnet': { inputCentsPer1M: 300, outputCentsPer1M: 1500 },
  'claude-4.6-opus': { inputCentsPer1M: 500, outputCentsPer1M: 2500 },
  'claude-4-6-opus': { inputCentsPer1M: 500, outputCentsPer1M: 2500 },
  'claude-4.6-sonnet': { inputCentsPer1M: 300, outputCentsPer1M: 1500 },
  'claude-4-6-sonnet': { inputCentsPer1M: 300, outputCentsPer1M: 1500 },
  'claude-opus-4.6': { inputCentsPer1M: 500, outputCentsPer1M: 2500 },
  'claude-sonnet-4.6': { inputCentsPer1M: 300, outputCentsPer1M: 1500 },
  'claude-opus-4.5': { inputCentsPer1M: 500, outputCentsPer1M: 2500 },
  'claude-sonnet-4.5': { inputCentsPer1M: 300, outputCentsPer1M: 1500 },
  'claude-haiku-4.5': { inputCentsPer1M: 100, outputCentsPer1M: 500 },

  // Cursor Composer
  'composer-1': { inputCentsPer1M: 125, outputCentsPer1M: 1000 },
  'composer-1.5': { inputCentsPer1M: 350, outputCentsPer1M: 1750 },
  'composer-1-5': { inputCentsPer1M: 350, outputCentsPer1M: 1750 },

  // Google Gemini
  'gemini-2.5-flash': { inputCentsPer1M: 30, outputCentsPer1M: 250 },
  'gemini-2-5-flash': { inputCentsPer1M: 30, outputCentsPer1M: 250 },
  'gemini-3-flash': { inputCentsPer1M: 50, outputCentsPer1M: 300 },
  'gemini-3-pro': { inputCentsPer1M: 200, outputCentsPer1M: 1200 },
  'gemini-3.1-pro': { inputCentsPer1M: 200, outputCentsPer1M: 1200 },
  'gemini-3-1-pro': { inputCentsPer1M: 200, outputCentsPer1M: 1200 },

  // OpenAI GPT-5 family
  'gpt-5': { inputCentsPer1M: 125, outputCentsPer1M: 1000 },
  'gpt-5-fast': { inputCentsPer1M: 250, outputCentsPer1M: 2000 },
  'gpt-5-mini': { inputCentsPer1M: 25, outputCentsPer1M: 200 },
  'gpt-5.4': { inputCentsPer1M: 250, outputCentsPer1M: 1500 },
  'gpt-5-4': { inputCentsPer1M: 250, outputCentsPer1M: 1500 },
  'gpt-5.2': { inputCentsPer1M: 175, outputCentsPer1M: 1400 },
  'gpt-5-2': { inputCentsPer1M: 175, outputCentsPer1M: 1400 },
  'gpt-5-codex': { inputCentsPer1M: 125, outputCentsPer1M: 1000 },
  'gpt-5.1-codex': { inputCentsPer1M: 125, outputCentsPer1M: 1000 },
  'gpt-5.1-codex-max': { inputCentsPer1M: 125, outputCentsPer1M: 1000 },
  'gpt-5.1-codex-mini': { inputCentsPer1M: 25, outputCentsPer1M: 200 },
  'gpt-5.2-codex': { inputCentsPer1M: 175, outputCentsPer1M: 1400 },
  'gpt-5.3-codex': { inputCentsPer1M: 175, outputCentsPer1M: 1400 },

  // xAI Grok
  'grok-code': { inputCentsPer1M: 20, outputCentsPer1M: 150 },

  // Moonshot Kimi
  'kimi-k2.5': { inputCentsPer1M: 60, outputCentsPer1M: 300 },
  'kimi-k2-5': { inputCentsPer1M: 60, outputCentsPer1M: 300 },

  // Legacy OpenAI (still referenced by some hooks)
  'gpt-4o': { inputCentsPer1M: 250, outputCentsPer1M: 1000 },
  'gpt-4o-mini': { inputCentsPer1M: 15, outputCentsPer1M: 60 },
  'gpt-4.1': { inputCentsPer1M: 200, outputCentsPer1M: 800 },
  'gpt-4.1-mini': { inputCentsPer1M: 80, outputCentsPer1M: 320 },
  'o4-mini': { inputCentsPer1M: 400, outputCentsPer1M: 1600 },
};

function normalizeModelKey(model: string): string {
  return model.toLowerCase().trim().replace(/\s+/g, '-');
}

/**
 * Get pricing for a model. Returns default for unknown models.
 */
export function getModelPricing(model: string | undefined): ModelPricing {
  const key = normalizeModelKey(model || 'auto');
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
