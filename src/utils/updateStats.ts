import * as vscode from 'vscode';
import { getSessionToken } from '../services/tokenStore';
import { fetchNewUsage } from '../services/api';
import { updateStatusBar, type UsageStatusBarItems } from '../handlers/statusBar';
import { readUsageEvents, getActiveConversationId } from '../services/usageStore';

export async function updateStats(
  items: UsageStatusBarItems,
  context: vscode.ExtensionContext
): Promise<void> {
  const token = await getSessionToken(context);
  if (!token) {
    updateStatusBar(items, undefined, undefined, false, false);
    return;
  }

  const config = vscode.workspace.getConfiguration('cursorUsageWizard');
  const planOverride = config.get<string>('planOverride', 'auto');
  const result = await fetchNewUsage(token);

  if (!result.authOk) {
    updateStatusBar(items, undefined, undefined, false, false);
    return;
  }

  let usage = result.usage;
  if (usage && planOverride !== 'auto') {
    const tier = planOverride as 'free' | 'pro' | 'pro_plus' | 'ultra';
    usage = { ...usage, plan: tier };
  }

  if (!usage) {
    updateStatusBar(items, undefined, undefined, false, true);
    return;
  }

  const storePathOverride = config.get<string>('usageStorePath');
  const showPerConversation = config.get<boolean>('showPerConversationInStatusBar', false);
  const showLatestInStatusBar = config.get<boolean>('showLatestInStatusBar', true);
  const conversations = readUsageEvents(storePathOverride);
  const activeConversationId = getActiveConversationId(storePathOverride);
  updateStatusBar(
    items,
    usage,
    conversations,
    showPerConversation,
    undefined,
    showLatestInStatusBar,
    activeConversationId
  );
}
