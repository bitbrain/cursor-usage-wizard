import * as fs from 'fs';
import * as path from 'path';
import { getUsageStorePath, estimateCostForModel } from '../utils/constants';

export interface ConversationUsage {
  conversationId: string;
  eventCount: number;
  estimatedCost: number;
  lastTs: number;
  source: 'agent' | 'tab';
}

const MAX_LINES = 50000;

export function readUsageEvents(overridePath?: string): ConversationUsage[] {
  const storePath = getUsageStorePath(overridePath);
  const usageFile = path.join(storePath, 'usage.jsonl');

  if (!fs.existsSync(usageFile)) {
    return [];
  }

  const content = fs.readFileSync(usageFile, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);

  const toProcess = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
  const byConversation = new Map<string, { events: number; cost: number; lastTs: number; source: string }>();

  for (const line of toProcess) {
    try {
      const row = JSON.parse(line) as {
        ts?: number;
        event?: string;
        conversation_id?: string;
        model?: string;
        source?: string;
      };
      const cid = row.conversation_id || 'unknown';
      const model = row.model || 'auto';
      const ts = row.ts || 0;
      const source = (row.source === 'tab' ? 'tab' : 'agent') as 'agent' | 'tab';

      const existing = byConversation.get(cid);
      const cost = estimateCostForModel(model);

      if (existing) {
        existing.events++;
        existing.cost += cost;
        existing.lastTs = Math.max(existing.lastTs, ts);
      } else {
        byConversation.set(cid, { events: 1, cost, lastTs: ts, source });
      }
    } catch (_) {
      // Skip invalid lines
    }
  }

  return Array.from(byConversation.entries())
    .map(([conversationId, data]) => ({
      conversationId,
      eventCount: data.events,
      estimatedCost: data.cost,
      lastTs: data.lastTs,
      source: data.source as 'agent' | 'tab',
    }))
    .sort((a, b) => b.lastTs - a.lastTs);
}

export function getLimits(overridePath?: string): Record<string, { maxCost?: number; maxEvents?: number }> {
  const storePath = getUsageStorePath(overridePath);
  const limitsFile = path.join(storePath, 'limits.json');

  if (!fs.existsSync(limitsFile)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(limitsFile, 'utf8'));
  } catch {
    return {};
  }
}

export function setLimit(
  conversationId: string,
  limit: { maxCost?: number; maxEvents?: number },
  overridePath?: string
): void {
  const storePath = getUsageStorePath(overridePath);
  const limitsFile = path.join(storePath, 'limits.json');

  if (!fs.existsSync(storePath)) {
    fs.mkdirSync(storePath, { recursive: true });
  }

  const limits = getLimits(overridePath);
  limits[conversationId] = limit;
  fs.writeFileSync(limitsFile, JSON.stringify(limits, null, 2), 'utf8');
}
