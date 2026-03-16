import * as vscode from 'vscode';
import { getSessionToken } from '../services/tokenStore';
import { fetchNewUsage } from '../services/api';
import { updateStatusBar, type UsageStatusBarItems } from '../handlers/statusBar';
import { readUsageEvents, getActiveConversationId } from '../services/usageStore';
import { getStartCents } from '../services/sessionCosts';

/**
 * Refresh usage from cursor.com and update status bar. Returns current usedCents (API pool)
 * when available so the extension can track lastKnownUsedCents for session cost snapshots.
 */
export async function updateStats(
  items: UsageStatusBarItems,
  context: vscode.ExtensionContext,
  storePathOverride?: string
): Promise<number | undefined> {
  const token = await getSessionToken(context);
  if (!token) {
    updateStatusBar(items, undefined, undefined, false, false);
    return undefined;
  }

  const config = vscode.workspace.getConfiguration('cursorUsageWizard');
  const planOverride = config.get<string>('planOverride', 'auto');
  const result = await fetchNewUsage(token);

  if (!result.authOk) {
    updateStatusBar(items, undefined, undefined, false, false);
    return undefined;
  }

  let usage = result.usage;
  if (usage && planOverride !== 'auto') {
    const tier = planOverride as 'free' | 'pro' | 'pro_plus' | 'ultra';
    usage = { ...usage, plan: tier };
  }

  if (!usage) {
    updateStatusBar(items, undefined, undefined, false, true);
    return undefined;
  }

  const showPerConversation = config.get<boolean>('showPerConversationInStatusBar', false);
  const showLatestInStatusBar = config.get<boolean>('showLatestInStatusBar', true);
  const conversations = readUsageEvents(storePathOverride);
  const activeConversationId = getActiveConversationId(storePathOverride);
  const usedCents = usage.apiPool.usedCents;
  const startCents = activeConversationId
    ? getStartCents(activeConversationId, storePathOverride)
    : undefined;
  if (
    activeConversationId != null &&
    usedCents != null &&
    typeof startCents === 'number'
  ) {
    const activeConv = conversations.find((c) => c.conversationId === activeConversationId);
    if (activeConv) {
      const liveDelta = Math.max(0, usedCents - startCents);
      if (liveDelta > 0) activeConv.deltaCents = liveDelta;
    }
  }
  updateStatusBar(
    items,
    usage,
    conversations,
    showPerConversation,
    undefined,
    showLatestInStatusBar,
    activeConversationId
  );
  return usage.apiPool.usedCents;
}
