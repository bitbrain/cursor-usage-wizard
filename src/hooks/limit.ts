#!/usr/bin/env node
/**
 * Limit hook: runs on beforeSubmitPrompt. Counts prompt tokens, writes last-prompt-tokens
 * for track.ts to pair with completion tokens. Enforces per-conversation limits using
 * session cost (deltaCents) or token-estimated cost as fallback.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { countTokens } from 'gpt-tokenizer';
import { tokenCostCents } from '../utils/pricing';

const BASE_USAGE_DIR = path.join(os.homedir(), '.cursor', 'usage-wizard');
const GLOBAL_LIMIT_KEY = '_global';

function getUsageDir(data: Record<string, unknown>): string {
  const workspaceRoot =
    Array.isArray(data.workspace_roots) && typeof data.workspace_roots[0] === 'string'
      ? data.workspace_roots[0]
      : undefined;
  const slug = workspaceRoot
    ? path.normalize(workspaceRoot).split(path.sep).filter(Boolean).join('-')
    : undefined;
  return slug ? path.join(BASE_USAGE_DIR, slug) : BASE_USAGE_DIR;
}

function getSessionCostCents(sessionCostsFile: string, conversationId: string): number | null {
  if (!fs.existsSync(sessionCostsFile)) return null;
  try {
    const store = JSON.parse(fs.readFileSync(sessionCostsFile, 'utf8')) as Record<
      string,
      { deltaCents?: number }
    >;
    const entry = store[conversationId];
    return entry && typeof entry.deltaCents === 'number' ? entry.deltaCents : null;
  } catch {
    return null;
  }
}

function getConversationTokenUsage(
  usageFile: string,
  sessionCostsFile: string,
  conversationId: string
): {
  events: number;
  costCents: number | null;
  estimatedTokenCents: number;
  lastModel: string;
} {
  let events = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let lastModel = 'auto';

  if (fs.existsSync(usageFile)) {
    const content = fs.readFileSync(usageFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as {
          conversation_id?: string;
          prompt_tokens?: number;
          completion_tokens?: number;
          model?: string;
        };
        if (row.conversation_id !== conversationId) continue;
        events++;
        if (typeof row.prompt_tokens === 'number') totalPromptTokens += row.prompt_tokens;
        if (typeof row.completion_tokens === 'number') totalCompletionTokens += row.completion_tokens;
        if (typeof row.model === 'string') lastModel = row.model;
      } catch {
        // skip invalid lines
      }
    }
  }

  const costCents = getSessionCostCents(sessionCostsFile, conversationId);
  const estimatedTokenCents =
    totalPromptTokens > 0 || totalCompletionTokens > 0
      ? tokenCostCents(lastModel, totalPromptTokens, totalCompletionTokens)
      : 0;

  return { events, costCents, estimatedTokenCents, lastModel };
}

function getLimits(limitsFile: string): Record<string, { maxCost?: number; maxEvents?: number }> {
  if (!fs.existsSync(limitsFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(limitsFile, 'utf8'));
  } catch {
    return {};
  }
}

function getTitles(titlesFile: string): Record<string, string> {
  if (!fs.existsSync(titlesFile)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(titlesFile, 'utf8')) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function setTitle(titlesFile: string, conversationId: string, title: string): void {
  const titles = getTitles(titlesFile);
  if (titles[conversationId] != null) return;
  titles[conversationId] = title;
  fs.writeFileSync(titlesFile, JSON.stringify(titles, null, 2), 'utf8');
}

function countTokensSafe(text: string): number {
  if (!text || typeof text !== 'string') return 0;
  try {
    return countTokens(text);
  } catch {
    return 0;
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  try {
    const data = (input ? JSON.parse(input) : {}) as Record<string, unknown>;
    const conversationId = data.conversation_id as string | undefined;
    if (!conversationId) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
      return;
    }

    const usageDir = getUsageDir(data);
    const usageFile = path.join(usageDir, 'usage.jsonl');
    const limitsFile = path.join(usageDir, 'limits.json');
    const sessionCostsFile = path.join(usageDir, 'session-costs.json');
    const titlesFile = path.join(usageDir, 'conversation-titles.json');
    const activeConversationFile = path.join(usageDir, 'active-conversation.json');
    const lastPromptTokensFile = path.join(usageDir, 'last-prompt-tokens.json');

    if (!fs.existsSync(usageDir)) {
      fs.mkdirSync(usageDir, { recursive: true });
    }
    fs.writeFileSync(
      activeConversationFile,
      JSON.stringify({ conversationId, ts: Date.now() }),
      'utf8'
    );

    const prompt = typeof data.prompt === 'string' ? data.prompt : '';
    const prompt_tokens = countTokensSafe(prompt);
    const generationId = typeof data.generation_id === 'string' ? data.generation_id : undefined;
    fs.writeFileSync(
      lastPromptTokensFile,
      JSON.stringify({ conversationId, generationId, prompt_tokens }),
      'utf8'
    );

    if (prompt) {
      const firstLine = prompt.trim().split('\n')[0].trim().slice(0, 80);
      if (firstLine) setTitle(titlesFile, conversationId, firstLine);
    }

    const limits = getLimits(limitsFile);
    const limit = limits[conversationId] || limits[GLOBAL_LIMIT_KEY];
    if (!limit) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
      return;
    }

    const { events, costCents, estimatedTokenCents } = getConversationTokenUsage(
      usageFile,
      sessionCostsFile,
      conversationId
    );
    const costDollars =
      costCents != null ? costCents / 100 : estimatedTokenCents > 0 ? estimatedTokenCents / 100 : null;

    if (limit.maxCost != null && costDollars != null && costDollars >= limit.maxCost) {
      const source = costCents != null ? 'Cursor billing' : 'token estimate';
      process.stdout.write(
        JSON.stringify({
          continue: false,
          user_message: `Conversation limit reached ($${costDollars.toFixed(2)} >= $${limit.maxCost}, from ${source}).`,
        }) + '\n'
      );
      process.exit(0);
      return;
    }

    if (limit.maxEvents != null && events >= limit.maxEvents) {
      process.stdout.write(
        JSON.stringify({
          continue: false,
          user_message: `Conversation limit reached (${events} events >= ${limit.maxEvents}).`,
        }) + '\n'
      );
      process.exit(0);
      return;
    }

    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  }
  process.exit(0);
});
