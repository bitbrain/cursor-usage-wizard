import * as fs from 'fs';
import * as path from 'path';
import { countTokens } from 'gpt-tokenizer';
import { getAgentTranscriptsPathForWorkspace } from '../utils/cursorProject';
import { tokenCostCents } from '../utils/pricing';

let workspaceRoot: string | undefined;

export function setWorkspaceRoot(root: string | undefined): void {
  workspaceRoot = root;
}

interface TokenCache {
  fileSize: number;
  subagentSizes: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
}

const cache = new Map<string, TokenCache>();

function countTextTokensSafe(text: string): number {
  if (!text) return 0;
  try {
    return countTokens(text);
  } catch {
    return Math.ceil(text.length / 4);
  }
}

type TranscriptEntry = {
  role?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
};

function readTranscriptFile(filePath: string): { inputTokens: number; outputTokens: number } {
  if (!fs.existsSync(filePath)) return { inputTokens: 0, outputTokens: 0 };
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        const text = (entry.message?.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('');
        if (!text) continue;
        const tokens = countTextTokensSafe(text);
        if (entry.role === 'user') inputTokens += tokens;
        else if (entry.role === 'assistant') outputTokens += tokens;
      } catch {
        // skip bad lines
      }
    }
  } catch {
    // ignore read errors
  }
  return { inputTokens, outputTokens };
}

function getFileSizeSafe(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Get token counts for a conversation from agent transcript JSONL (main + subagents).
 * Caches by file sizes. Returns undefined when workspace root is not set or no transcript exists.
 * Used for cost (estimateTranscriptCostCents) and for energy/water/CO2 when hooks have no token data.
 */
export function getTranscriptTokenCounts(
  conversationId: string
): { inputTokens: number; outputTokens: number } | undefined {
  const result = getTranscriptTokensInternal(conversationId);
  if (!result) return undefined;
  if (result.inputTokens === 0 && result.outputTokens === 0) return undefined;
  return result;
}

function getTranscriptTokensInternal(
  conversationId: string
): { inputTokens: number; outputTokens: number } | undefined {
  if (!workspaceRoot) return undefined;

  const transcriptsBase = getAgentTranscriptsPathForWorkspace(workspaceRoot);
  const convDir = path.join(transcriptsBase, conversationId);
  if (!fs.existsSync(convDir)) return undefined;

  const mainFile = path.join(convDir, `${conversationId}.jsonl`);
  const subagentsDir = path.join(convDir, 'subagents');

  const mainSize = getFileSizeSafe(mainFile);

  const subagentFiles: Record<string, number> = {};
  if (fs.existsSync(subagentsDir)) {
    try {
      for (const file of fs.readdirSync(subagentsDir)) {
        if (!file.endsWith('.jsonl')) continue;
        subagentFiles[file] = getFileSizeSafe(path.join(subagentsDir, file));
      }
    } catch {
      // ignore
    }
  }

  const cached = cache.get(conversationId);
  if (cached) {
    const sameMain = cached.fileSize === mainSize;
    const sameSubCount =
      Object.keys(subagentFiles).length === Object.keys(cached.subagentSizes).length;
    const sameSubSizes =
      sameSubCount &&
      Object.entries(subagentFiles).every(([k, v]) => cached.subagentSizes[k] === v);

    if (sameMain && sameSubSizes) {
      return { inputTokens: cached.inputTokens, outputTokens: cached.outputTokens };
    }
  }

  const main = readTranscriptFile(mainFile);
  let inputTokens = main.inputTokens;
  let outputTokens = main.outputTokens;

  for (const file of Object.keys(subagentFiles)) {
    const sub = readTranscriptFile(path.join(subagentsDir, file));
    inputTokens += sub.inputTokens;
    outputTokens += sub.outputTokens;
  }

  cache.set(conversationId, {
    fileSize: mainSize,
    subagentSizes: subagentFiles,
    inputTokens,
    outputTokens,
  });

  return { inputTokens, outputTokens };
}

/**
 * Estimate cost (in cents) for a conversation by tokenising its agent transcript JSONL.
 * Includes subagent transcripts. Caches results by file size to avoid re-counting
 * transcripts that haven't changed.
 *
 * Returns undefined when the workspace root is not set or no transcript exists.
 */
export function estimateTranscriptCostCents(
  conversationId: string,
  model: string | undefined
): number | undefined {
  const tokens = getTranscriptTokensInternal(conversationId);
  if (!tokens) return undefined;
  if (tokens.inputTokens === 0 && tokens.outputTokens === 0) return undefined;
  return tokenCostCents(model, tokens.inputTokens, tokens.outputTokens);
}
