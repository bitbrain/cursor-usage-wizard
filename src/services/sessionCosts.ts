import * as fs from 'fs';
import * as path from 'path';
import { getUsageStorePath } from '../utils/constants';

const SESSION_COSTS_FILENAME = 'session-costs.json';
const SESSION_STARTS_FILENAME = 'session-starts.json';

function getSessionCostsPath(overridePath?: string): string {
  return path.join(getUsageStorePath(overridePath), SESSION_COSTS_FILENAME);
}

function getSessionStartsPath(overridePath?: string): string {
  return path.join(getUsageStorePath(overridePath), SESSION_STARTS_FILENAME);
}

/**
 * Record that a conversation has started; store current global usedCents as the baseline
 * for computing delta when the conversation ends.
 */
export function snapshotStart(
  conversationId: string,
  usedCents: number,
  overridePath?: string
): void {
  const storePath = getUsageStorePath(overridePath);
  if (!fs.existsSync(storePath)) {
    fs.mkdirSync(storePath, { recursive: true });
  }
  const file = getSessionStartsPath(overridePath);
  let starts: Record<string, number> = {};
  if (fs.existsSync(file)) {
    try {
      starts = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // ignore
    }
  }
  if (typeof starts[conversationId] === 'number') {
    return;
  }
  starts[conversationId] = usedCents;
  fs.writeFileSync(file, JSON.stringify(starts, null, 2), 'utf8');
}

/**
 * Conversation ended: compute deltaCents = usedCents - startCents and persist to session-costs.json.
 */
export function recordEnd(
  conversationId: string,
  usedCents: number,
  overridePath?: string
): void {
  const startsPath = getSessionStartsPath(overridePath);
  let startCents: number | undefined;
  if (fs.existsSync(startsPath)) {
    try {
      const starts = JSON.parse(fs.readFileSync(startsPath, 'utf8')) as Record<string, number>;
      startCents = starts[conversationId];
      delete starts[conversationId];
      fs.writeFileSync(startsPath, JSON.stringify(starts, null, 2), 'utf8');
    } catch {
      // ignore
    }
  }
  if (startCents == null) return;
  const deltaCents = Math.max(0, usedCents - startCents);
  const costsPath = getSessionCostsPath(overridePath);
  const storePath = getUsageStorePath(overridePath);
  if (!fs.existsSync(storePath)) {
    fs.mkdirSync(storePath, { recursive: true });
  }
  let costs: Record<string, { deltaCents: number }> = {};
  if (fs.existsSync(costsPath)) {
    try {
      costs = JSON.parse(fs.readFileSync(costsPath, 'utf8'));
    } catch {
      // ignore
    }
  }
  costs[conversationId] = { deltaCents };
  fs.writeFileSync(costsPath, JSON.stringify(costs, null, 2), 'utf8');
}

/**
 * Get the stored start usedCents for a conversation (for live delta display).
 */
export function getStartCents(conversationId: string, overridePath?: string): number | undefined {
  const file = getSessionStartsPath(overridePath);
  if (!fs.existsSync(file)) return undefined;
  try {
    const starts = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, number>;
    const v = starts[conversationId];
    return typeof v === 'number' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get all persisted session deltas (conversationId → deltaCents).
 */
export function getAllSessionCosts(overridePath?: string): Record<string, number> {
  const file = getSessionCostsPath(overridePath);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { deltaCents?: number }>;
    const out: Record<string, number> = {};
    for (const [id, entry] of Object.entries(raw)) {
      if (entry && typeof entry.deltaCents === 'number' && entry.deltaCents > 0) out[id] = entry.deltaCents;
    }
    return out;
  } catch {
    return {};
  }
}
