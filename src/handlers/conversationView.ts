import * as vscode from 'vscode';
import { readUsageEvents, getLimits, setLimit } from '../services/usageStore';
import { getUsageStorePath } from '../utils/constants';

export async function showConversations(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('cursorUsageWizard');
  const storePathOverride = config.get<string>('usageStorePath');
  const storePath = getUsageStorePath(storePathOverride);

  const conversations = readUsageEvents(storePathOverride);
  const limits = getLimits(storePathOverride);

  if (conversations.length === 0) {
    vscode.window.showInformationMessage(
      'No conversation usage yet. Start an Agent or Tab session to track usage.'
    );
    return;
  }

  const items = conversations.map((c) => {
    const short = c.conversationId.slice(0, 12);
    const limit = limits[c.conversationId];
    const limitStr = limit
      ? ` [limit: $${limit.maxCost ?? '?'}/${limit.maxEvents ?? '?'}]`
      : '';
    return {
      label: `${short}...`,
      description: `${c.eventCount} events, ~$${c.estimatedCost.toFixed(2)}${limitStr}`,
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

export async function setConversationLimit(
  conversationId?: string,
  storePathOverride?: string
): Promise<void> {
  const cid = conversationId;
  if (!cid) {
    const config = vscode.workspace.getConfiguration('cursorUsageWizard');
    const storePath = getUsageStorePath(config.get<string>('usageStorePath'));
    const conversations = readUsageEvents(storePathOverride);
    if (conversations.length === 0) {
      vscode.window.showWarningMessage('No conversations to set limit for.');
      return;
    }
    const selected = await vscode.window.showQuickPick(
      conversations.map((c) => ({
        label: c.conversationId.slice(0, 12) + '...',
        conversationId: c.conversationId,
      })),
      { placeHolder: 'Select conversation' }
    );
    if (!selected) return;
    return setConversationLimit(selected.conversationId, storePathOverride);
  }

  const presets = [
    { label: '$0.50', value: 0.5 },
    { label: '$1', value: 1 },
    { label: '$2', value: 2 },
    { label: '$5', value: 5 },
    { label: 'Custom', value: -1 },
  ];

  const choice = await vscode.window.showQuickPick(presets, {
    placeHolder: 'Set cost limit for conversation',
  });

  if (!choice) return;

  let maxCost: number;
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

  setLimit(cid, { maxCost }, storePathOverride);
  vscode.window.showInformationMessage(`Limit set: $${maxCost} for conversation ${cid.slice(0, 8)}...`);
}
