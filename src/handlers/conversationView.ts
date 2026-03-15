import * as vscode from 'vscode';
import { readUsageEvents, getLimits, setLimit, GLOBAL_LIMIT_KEY, getTitles } from '../services/usageStore';
import { getUsageStorePath } from '../utils/constants';

export async function showConversations(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('cursorUsageWizard');
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const storePathOverride =
    (config.get<string>('usageStorePath') || '').trim() ||
    (workspaceRoot ? getUsageStorePath(undefined, workspaceRoot) : undefined);
  const storePath = getUsageStorePath(storePathOverride);

  const conversations = readUsageEvents(storePathOverride);
  const limits = getLimits(storePathOverride);
  const titles = getTitles(storePathOverride);

  if (conversations.length === 0) {
    vscode.window.showInformationMessage(
      'No conversation usage yet. Start an Agent or Tab session to track usage.'
    );
    return;
  }

  const items = conversations.map((c) => {
    const label = titles[c.conversationId] || c.conversationId.slice(0, 12) + '...';
    const limit = limits[c.conversationId] || limits[GLOBAL_LIMIT_KEY];
    const limitStr = limit
      ? ` [limit: $${limit.maxCost ?? '?'}/${limit.maxEvents ?? '?'}]`
      : '';
    const cents = c.deltaCents ?? c.estimatedTokenCents;
    const costStr =
      cents != null
        ? `$${(cents / 100).toFixed(2)}`
        : c.turnCount > 0
          ? `${c.turnCount} turn${c.turnCount === 1 ? '' : 's'}`
          : '—';
    return {
      label: label.length > 60 ? label.slice(0, 57) + '...' : label,
      description: `${c.eventCount} events, ${costStr}${limitStr}`,
      detail: c.conversationId,
      conversationId: c.conversationId,
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a conversation to set limit',
    matchOnDescription: true,
  });

  if (selected) {
    await setConversationLimit(selected.conversationId, storePathOverride || undefined);
  }
}

function getResolvedStorePathOverride(): string | undefined {
  const config = vscode.workspace.getConfiguration('cursorUsageWizard');
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return (
    (config.get<string>('usageStorePath') || '').trim() ||
    (workspaceRoot ? getUsageStorePath(undefined, workspaceRoot) : undefined)
  );
}

export async function setConversationLimit(
  conversationId?: string,
  storePathOverride?: string
): Promise<void> {
  const resolvedOverride = storePathOverride ?? getResolvedStorePathOverride();
  const cid = conversationId;
  if (!cid) {
    const conversations = readUsageEvents(resolvedOverride);
    const scopeChoice = await vscode.window.showQuickPick(
      [
        { label: 'Global default (all conversations)', value: 'global' as const },
        { label: 'A specific conversation', value: 'conversation' as const },
      ],
      { placeHolder: 'Set limit for…' }
    );
    if (!scopeChoice) return;
    if (scopeChoice.value === 'global') {
      return setConversationLimit(GLOBAL_LIMIT_KEY, resolvedOverride);
    }
    if (conversations.length === 0) {
      vscode.window.showWarningMessage('No conversations to set limit for.');
      return;
    }
    const titlesForPick = getTitles(resolvedOverride);
    const selected = await vscode.window.showQuickPick(
      conversations.map((c) => ({
        label: titlesForPick[c.conversationId] || c.conversationId.slice(0, 12) + '...',
        description: c.conversationId.slice(0, 12) + '...',
        conversationId: c.conversationId,
      })),
      { placeHolder: 'Select conversation' }
    );
    if (!selected) return;
    return setConversationLimit(selected.conversationId, resolvedOverride);
  }

  const isGlobal = cid === GLOBAL_LIMIT_KEY;
  const limitTypeChoice = await vscode.window.showQuickPick(
    [
      { label: 'Cost limit ($)', value: 'cost' as const },
      { label: 'Event limit (count)', value: 'events' as const },
      { label: 'Both', value: 'both' as const },
    ],
    { placeHolder: 'What limit do you want to set?' }
  );

  if (!limitTypeChoice) return;

  const wantCost = limitTypeChoice.value === 'cost' || limitTypeChoice.value === 'both';
  const wantEvents = limitTypeChoice.value === 'events' || limitTypeChoice.value === 'both';

  let maxCost: number | undefined;
  let maxEvents: number | undefined;

  if (wantCost) {
    const presets = [
      { label: '$0.50', value: 0.5 },
      { label: '$1', value: 1 },
      { label: '$2', value: 2 },
      { label: '$5', value: 5 },
      { label: 'Custom', value: -1 },
    ];
    const choice = await vscode.window.showQuickPick(presets, {
      placeHolder: isGlobal ? 'Set cost limit (per conversation)' : 'Set cost limit for conversation',
    });
    if (!choice) return;
    if (choice.value === -1) {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter max cost ($)',
        validateInput: (v) => {
          const n = parseFloat(v);
          return isNaN(n) || n <= 0 ? 'Enter a positive number' : null;
        },
      });
      if (input == null) return;
      maxCost = parseFloat(input);
    } else {
      maxCost = choice.value;
    }
  }

  if (wantEvents) {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter max event count',
      validateInput: (v) => {
        const n = parseInt(v, 10);
        return !Number.isInteger(n) || n <= 0 ? 'Enter a positive integer' : null;
      },
    });
    if (input == null) return;
    maxEvents = parseInt(input, 10);
  }

  const limits = getLimits(resolvedOverride);
  const existing = limits[cid] ?? {};
  const limit: { maxCost?: number; maxEvents?: number } = { ...existing };
  if (maxCost !== undefined) limit.maxCost = maxCost;
  if (maxEvents !== undefined) limit.maxEvents = maxEvents;

  setLimit(cid, limit, resolvedOverride);

  const parts: string[] = [];
  if (limit.maxCost != null) parts.push(`$${limit.maxCost}`);
  if (limit.maxEvents != null) parts.push(`${limit.maxEvents} events`);
  const msg =
    parts.length > 0
      ? isGlobal
        ? `Global limit set: ${parts.join(' and ')} per conversation.`
        : `Limit set: ${parts.join(' and ')} for conversation ${cid.slice(0, 8)}...`
      : isGlobal
        ? 'Global limit updated.'
        : `Limit updated for conversation ${cid.slice(0, 8)}...`;
  vscode.window.showInformationMessage(msg);
}
