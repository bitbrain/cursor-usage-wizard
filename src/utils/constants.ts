import * as os from 'os';
import * as path from 'path';

export function getUsageStorePath(override?: string): string {
  if (override && override.trim() !== '') {
    return override.trim();
  }
  return path.join(os.homedir(), '.cursor', 'usage-wizard');
}

export const MODEL_COST_ESTIMATES: Record<string, number> = {
  'claude-opus': 0.025,
  'claude-sonnet': 0.012,
  'claude-4': 0.012,
  'claude-3': 0.012,
  'gpt-4': 0.02,
  'gpt-4o': 0.02,
  gemini: 0.005,
  auto: 0.003,
  default: 0.005,
};

export function estimateCostForModel(model: string): number {
  const lower = model.toLowerCase();
  for (const [key, cost] of Object.entries(MODEL_COST_ESTIMATES)) {
    if (key !== 'default' && lower.includes(key)) {
      return cost;
    }
  }
  return MODEL_COST_ESTIMATES.default;
}
