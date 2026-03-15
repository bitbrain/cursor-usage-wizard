#!/usr/bin/env node
/**
 * Track hook: appends events to usage.jsonl. On afterAgentResponse, counts completion
 * tokens from data.response/data.text and pairs with prompt_tokens from limit hook.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { countTokens } from 'gpt-tokenizer';

const BASE_USAGE_DIR = path.join(os.homedir(), '.cursor', 'usage-wizard');

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

const eventArg = process.argv.find((a) => a.startsWith('--'));
const eventName = eventArg ? eventArg.replace('--', '') : 'unknown';

function countTokensSafe(text: string): number {
  if (!text || typeof text !== 'string') return 0;
  try {
    return countTokens(text);
  } catch {
    return 0;
  }
}

const FILE_READS_MAX_LINES = 2000;

function sumAndPruneFileReads(fileReadsFile: string, generationId: string): number {
  if (!fs.existsSync(fileReadsFile)) return 0;
  let sum = 0;
  const kept: string[] = [];
  try {
    const content = fs.readFileSync(fileReadsFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as { generation_id?: string; tokens?: number };
        if (row.generation_id === generationId && typeof row.tokens === 'number') {
          sum += row.tokens;
        } else {
          kept.push(line);
        }
      } catch {
        // skip malformed line
      }
    }
    const pruned = kept.length > FILE_READS_MAX_LINES ? kept.slice(-FILE_READS_MAX_LINES) : kept;
    fs.writeFileSync(fileReadsFile, pruned.length ? pruned.join('\n') + '\n' : '', 'utf8');
  } catch {
    // ignore read/write errors
  }
  return sum;
}

function readLastPromptTokens(
  lastPromptTokensFile: string,
  conversationId: string
): { prompt_tokens: number; generationId?: string } | undefined {
  if (!fs.existsSync(lastPromptTokensFile)) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(lastPromptTokensFile, 'utf8')) as {
      conversationId?: string;
      generationId?: string;
      prompt_tokens?: number;
    };
    if (data.conversationId === conversationId && typeof data.prompt_tokens === 'number') {
      return {
        prompt_tokens: data.prompt_tokens,
        generationId: typeof data.generationId === 'string' ? data.generationId : undefined,
      };
    }
  } catch {
    // ignore
  }
  return undefined;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  try {
    const data = (input ? JSON.parse(input) : {}) as Record<string, unknown>;
    const usageDir = getUsageDir(data);
    const usageFile = path.join(usageDir, 'usage.jsonl');
    const fileReadsFile = path.join(usageDir, 'file-reads.jsonl');
    const activeConversationFile = path.join(usageDir, 'active-conversation.json');
    const lastPromptTokensFile = path.join(usageDir, 'last-prompt-tokens.json');

    if (eventName === 'beforeReadFile') {
      const generation_id = typeof data.generation_id === 'string' ? data.generation_id : undefined;
      const content = typeof data.content === 'string' ? data.content : '';
      if (generation_id !== undefined) {
        const tokens = countTokensSafe(content);
        if (!fs.existsSync(usageDir)) {
          fs.mkdirSync(usageDir, { recursive: true });
        }
        const line = JSON.stringify({ generation_id, tokens, ts: Date.now() }) + '\n';
        fs.appendFileSync(fileReadsFile, line);
      }
      process.stdout.write(JSON.stringify({ permission: 'allow' }) + '\n');
      process.exit(0);
      return;
    }

    const conversationId = (data.conversation_id as string) || (data.session_id as string) || 'unknown';
    const model = (data.model as string) || 'auto';
    const source = eventName === 'afterTabFileEdit' ? 'tab' : 'agent';

    const payload: Record<string, unknown> = {
      ts: Date.now(),
      event: eventName,
      conversation_id: conversationId,
      model,
      source,
    };

    if (eventName === 'afterAgentResponse') {
      const responseText =
        (typeof data.response === 'string' ? data.response : null) ??
        (typeof data.text === 'string' ? data.text : null) ??
        '';
      const completion_tokens = countTokensSafe(responseText);
      const lastPrompt = readLastPromptTokens(lastPromptTokensFile, conversationId);
      let prompt_tokens: number | undefined = lastPrompt?.prompt_tokens;
      const generationId = lastPrompt?.generationId ?? (typeof data.generation_id === 'string' ? data.generation_id : undefined);

      if (generationId !== undefined) {
        const fileReadTokens = sumAndPruneFileReads(fileReadsFile, generationId);
        if (fileReadTokens > 0) {
          prompt_tokens = (prompt_tokens ?? 0) + fileReadTokens;
        }
      }
      if (completion_tokens > 0 || prompt_tokens !== undefined) {
        if (typeof prompt_tokens === 'number') payload.prompt_tokens = prompt_tokens;
        payload.completion_tokens = completion_tokens;
      }
    }

    const line = JSON.stringify(payload) + '\n';

    if (!fs.existsSync(usageDir)) {
      fs.mkdirSync(usageDir, { recursive: true });
    }
    fs.appendFileSync(usageFile, line);
    if (conversationId !== 'unknown') {
      fs.writeFileSync(
        activeConversationFile,
        JSON.stringify({ conversationId, ts: Date.now() }),
        'utf8'
      );
    }
  } catch {
    // Silently ignore parse errors
  }
  process.exit(0);
});
