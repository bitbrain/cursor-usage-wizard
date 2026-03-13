import * as fs from 'fs';
import * as path from 'path';
import { getUsageStorePath, estimateCostForModel } from '../utils/constants';
import { getAgentTranscriptsPathForWorkspace } from '../utils/cursorProject';

const ACTIVE_CONVERSATION_FILENAME = 'active-conversation.json';
const TITLES_FILENAME = 'conversation-titles.json';

/** Key in limits.json for the global default limit (applies to every conversation). */
export const GLOBAL_LIMIT_KEY = '_global';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the conversation ID that was last active (from hooks). Returns undefined if the file
 * is missing or invalid. Uses the same store path as usage.jsonl (respects override).
 */
export function getActiveConversationId(overridePath?: string): string | undefined {
  const storePath = getUsageStorePath(overridePath);
  const file = path.join(storePath, ACTIVE_CONVERSATION_FILENAME);
  if (!fs.existsSync(file)) {
    return undefined;
  }
  try {
    const content = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(content) as { conversationId?: string };
    return typeof parsed.conversationId === 'string' ? parsed.conversationId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write the active conversation ID (same format as hooks). Used when transcript watcher
 * detects activity so the status bar shows the current conversation.
 */
export function setActiveConversationId(conversationId: string, overridePath?: string): void {
  const storePath = getUsageStorePath(overridePath);
  if (!fs.existsSync(storePath)) {
    fs.mkdirSync(storePath, { recursive: true });
  }
  const file = path.join(storePath, ACTIVE_CONVERSATION_FILENAME);
  fs.writeFileSync(
    file,
    JSON.stringify({ conversationId, ts: Date.now() }, null, 0),
    'utf8'
  );
}

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

/**
 * Read conversation titles (first prompt line), keyed by conversation ID.
 * Written by the beforeSubmitPrompt hook when it first sees a conversation.
 */
export function getTitles(overridePath?: string): Record<string, string> {
  const storePath = getUsageStorePath(overridePath);
  const file = path.join(storePath, TITLES_FILENAME);
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

const DEBOUNCE_MS = 400;

/**
 * Watch usage.jsonl for changes and invoke callback with fresh ConversationUsage[] (debounced).
 * Store path uses getUsageStorePath(overridePath). Returns a disposable to stop watching.
 */
export function watchUsageFile(
  overridePath: string | undefined,
  callback: (conversations: ConversationUsage[]) => void
): { dispose: () => void } {
  const storePath = getUsageStorePath(overridePath);
  const usageFile = path.join(storePath, 'usage.jsonl');
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let watcher: fs.FSWatcher | undefined;

  const run = () => {
    debounceTimer = undefined;
    try {
      callback(readUsageEvents(overridePath));
    } catch (_) {
      // ignore read errors
    }
  };

  const schedule = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, DEBOUNCE_MS);
  };

  try {
    if (fs.existsSync(usageFile)) {
      watcher = fs.watch(usageFile, { encoding: 'utf8' }, () => schedule());
    } else {
      watcher = fs.watch(storePath, { encoding: 'utf8' }, (_, filename) => {
        if (filename === 'usage.jsonl') schedule();
      });
    }
  } catch (_) {
    // store path may not exist yet
  }

  return {
    dispose() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (watcher) {
        watcher.close();
        watcher = undefined;
      }
    },
  };
}

/**
 * Watch active-conversation.json for changes and invoke callback (debounced).
 * Use to refresh the status bar when the user switches chats and a hook updates the file.
 */
export function watchActiveConversationFile(
  overridePath: string | undefined,
  callback: () => void
): { dispose: () => void } {
  const storePath = getUsageStorePath(overridePath);
  const activeFile = path.join(storePath, ACTIVE_CONVERSATION_FILENAME);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let watcher: fs.FSWatcher | undefined;

  const schedule = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      try {
        callback();
      } catch (_) {
        // ignore
      }
    }, DEBOUNCE_MS);
  };

  try {
    if (fs.existsSync(activeFile)) {
      watcher = fs.watch(activeFile, { encoding: 'utf8' }, () => schedule());
    } else {
      watcher = fs.watch(storePath, { encoding: 'utf8' }, (_, filename) => {
        if (filename === ACTIVE_CONVERSATION_FILENAME) schedule();
      });
    }
  } catch (_) {
    // store path may not exist yet
  }

  return {
    dispose() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (watcher) {
        watcher.close();
        watcher = undefined;
      }
    },
  };
}

function parseConversationIdFromTranscriptFilename(filename: string | null): string | undefined {
  if (!filename || typeof filename !== 'string') return undefined;
  const parts = filename.split(path.sep).filter(Boolean);
  const segment = parts.length > 1 ? parts[0] : path.basename(filename, '.jsonl');
  const candidate = segment.replace(/\.jsonl$/i, '');
  return UUID_REGEX.test(candidate) ? candidate : undefined;
}

const NOOP_DISPOSABLE = { dispose: () => {} };

/**
 * Watch Cursor's agent-transcripts directory; when a transcript file changes, treat that
 * conversation as active and invoke callback(conversationId). Used to update the status bar
 * when the user switches agents (when Cursor writes to the transcript).
 */
export function watchAgentTranscripts(
  workspaceRootPath: string | undefined,
  storePathOverride: string | undefined,
  callback: (conversationId: string) => void
): { dispose: () => void } {
  if (!workspaceRootPath) {
    return NOOP_DISPOSABLE;
  }
  const agentTranscriptsPath = getAgentTranscriptsPathForWorkspace(workspaceRootPath);
  if (!fs.existsSync(agentTranscriptsPath)) {
    return NOOP_DISPOSABLE;
  }
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let lastConversationId: string | undefined;
  let watcher: fs.FSWatcher | undefined;

  const schedule = (conversationId: string | undefined) => {
    if (conversationId === undefined) return;
    lastConversationId = conversationId;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      const id = lastConversationId;
      lastConversationId = undefined;
      if (id) {
        try {
          callback(id);
        } catch (_) {
          // ignore
        }
      }
    }, DEBOUNCE_MS);
  };

  try {
    watcher = fs.watch(
      agentTranscriptsPath,
      { recursive: true, encoding: 'utf8' },
      (event, filename) => {
        const conversationId = parseConversationIdFromTranscriptFilename(filename);
        if (conversationId) schedule(conversationId);
      }
    );
  } catch (_) {
    return NOOP_DISPOSABLE;
  }

  return {
    dispose() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      lastConversationId = undefined;
      if (watcher) {
        watcher.close();
        watcher = undefined;
      }
    },
  };
}
