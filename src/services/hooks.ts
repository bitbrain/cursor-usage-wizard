import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

const CURSOR_HOOKS_DIR = path.join(os.homedir(), '.cursor');
const HOOKS_JSON_PATH = path.join(CURSOR_HOOKS_DIR, 'hooks.json');
const USAGE_WIZARD_DIR = path.join(CURSOR_HOOKS_DIR, 'usage-wizard');

const HOOK_ENTRIES: Record<string, Array<{ command: string }>> = {
  sessionStart: [{ command: `node "${path.join(USAGE_WIZARD_DIR, 'track.js')}" --sessionStart` }],
  sessionEnd: [{ command: `node "${path.join(USAGE_WIZARD_DIR, 'track.js')}" --sessionEnd` }],
  postToolUse: [{ command: `node "${path.join(USAGE_WIZARD_DIR, 'track.js')}" --postToolUse` }],
  afterAgentResponse: [
    { command: `node "${path.join(USAGE_WIZARD_DIR, 'track.js')}" --afterAgentResponse` },
  ],
  afterTabFileEdit: [{ command: `node "${path.join(USAGE_WIZARD_DIR, 'track.js')}" --afterTabFileEdit` }],
  beforeReadFile: [{ command: `node "${path.join(USAGE_WIZARD_DIR, 'track.js')}" --beforeReadFile` }],
  beforeSubmitPrompt: [{ command: `node "${path.join(USAGE_WIZARD_DIR, 'limit.js')}"` }],
};

function readExistingHooks(): Record<string, unknown> {
  if (!fs.existsSync(HOOKS_JSON_PATH)) {
    return { version: 1, hooks: {} };
  }
  try {
    const content = fs.readFileSync(HOOKS_JSON_PATH, 'utf8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return parsed.hooks ? parsed : { ...parsed, hooks: {} };
  } catch {
    return { version: 1, hooks: {} };
  }
}

function mergeHooks(existing: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...existing };
  const hooks = (merged.hooks as Record<string, unknown[]>) || {};

  for (const [event, entries] of Object.entries(HOOK_ENTRIES)) {
    const existingEntries = (hooks[event] as Array<Record<string, unknown>>) || [];
    const withoutOurs = existingEntries.filter(
      (e) => typeof e.command === 'string' && !e.command.includes('usage-wizard')
    );
    hooks[event] = [...withoutOurs, ...entries];
  }

  merged.hooks = hooks;
  return merged;
}

export function installHooks(extensionPath: string): boolean {
  const outDir = path.join(extensionPath, 'out');
  const hooksSource = path.join(outDir, 'hooks');
  if (!fs.existsSync(hooksSource)) {
    return false;
  }

  if (!fs.existsSync(USAGE_WIZARD_DIR)) {
    fs.mkdirSync(USAGE_WIZARD_DIR, { recursive: true });
  }
  if (!fs.existsSync(CURSOR_HOOKS_DIR)) {
    fs.mkdirSync(CURSOR_HOOKS_DIR, { recursive: true });
  }

  const trackSrc = path.join(hooksSource, 'track.js');
  const limitSrc = path.join(hooksSource, 'limit.js');

  if (fs.existsSync(trackSrc)) {
    fs.copyFileSync(trackSrc, path.join(USAGE_WIZARD_DIR, 'track.js'));
  }
  if (fs.existsSync(limitSrc)) {
    fs.copyFileSync(limitSrc, path.join(USAGE_WIZARD_DIR, 'limit.js'));
  }

  // Hook bundles require shared chunks (e.g. tokenizer, pricing) from ../ so copy them to CURSOR_HOOKS_DIR
  try {
    const outFiles = fs.readdirSync(outDir, { withFileTypes: true });
    for (const ent of outFiles) {
      if (ent.isFile() && ent.name.endsWith('.js') && ent.name !== 'extension.js') {
        fs.copyFileSync(
          path.join(outDir, ent.name),
          path.join(CURSOR_HOOKS_DIR, ent.name)
        );
      }
    }
  } catch {
    // non-fatal
  }

  const existing = readExistingHooks();
  const merged = mergeHooks(existing);

  if (!fs.existsSync(CURSOR_HOOKS_DIR)) {
    fs.mkdirSync(CURSOR_HOOKS_DIR, { recursive: true });
  }

  fs.writeFileSync(HOOKS_JSON_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return true;
}

export function getUsageStorePath(override?: string): string {
  if (override && override.trim() !== '') {
    return override.trim();
  }
  return USAGE_WIZARD_DIR;
}
