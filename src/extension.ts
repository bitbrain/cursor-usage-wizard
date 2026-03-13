import * as vscode from 'vscode';
import { createUsageStatusBarItems, updateLatestStatusBarItem } from './handlers/statusBar';
import { updateStats } from './utils/updateStats';
import { installHooks } from './services/hooks';
import { showConversations, setConversationLimit } from './handlers/conversationView';
import {
  setSessionToken as storeSessionToken,
  clearSessionToken as deleteSessionToken,
} from './services/tokenStore';
import { initLogger, log } from './utils/logger';
import { ConversationTreeDataProvider } from './views/conversationTree';
import { ConversationDetailProvider } from './views/conversationDetail';
import {
  watchUsageFile,
  watchActiveConversationFile,
  watchAgentTranscripts,
  setActiveConversationId,
  readUsageEvents,
  getActiveConversationId,
  getLimits,
  getTitles,
  GLOBAL_LIMIT_KEY,
} from './services/usageStore';
import type { ConversationUsage } from './services/usageStore';

let statusBarItems: ReturnType<typeof createUsageStatusBarItems>;
let refreshInterval: NodeJS.Timeout | undefined;

/** Conversation IDs we've already shown a global-limit warning for this session (avoid spam). */
const notifiedOverLimit = new Set<string>();

function checkGlobalLimitAlerts(
  conversations: ConversationUsage[],
  storePathOverride: string | undefined
): void {
  const limits = getLimits(storePathOverride);
  const global = limits[GLOBAL_LIMIT_KEY];
  if (!global || (global.maxCost == null && global.maxEvents == null)) return;
  const titles = getTitles(storePathOverride);
  for (const c of conversations) {
    const overCost = global.maxCost != null && c.estimatedCost >= global.maxCost;
    const overEvents = global.maxEvents != null && c.eventCount >= global.maxEvents;
    if (!overCost && !overEvents) continue;
    if (notifiedOverLimit.has(c.conversationId)) continue;
    notifiedOverLimit.add(c.conversationId);
    const name = titles[c.conversationId] || c.conversationId.slice(0, 12) + '...';
    const msg =
      overCost && overEvents
        ? `"${name}" has exceeded the global limit ($${c.estimatedCost.toFixed(2)} >= $${global.maxCost}, ${c.eventCount} events >= ${global.maxEvents}).`
        : overCost
          ? `"${name}" has exceeded the global cost limit ($${c.estimatedCost.toFixed(2)} >= $${global.maxCost}).`
          : `"${name}" has exceeded the global event limit (${c.eventCount} >= ${global.maxEvents}).`;
    vscode.window.showWarningMessage(msg);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  try {
    initLogger();
    statusBarItems = createUsageStatusBarItems();
    context.subscriptions.push(
      statusBarItems.total,
      statusBarItems.auto,
      statusBarItems.api,
      statusBarItems.onDemand,
      statusBarItems.latest
    );

    const config = vscode.workspace.getConfiguration('cursorUsageWizard');
    const storePathOverride = (config.get<string>('usageStorePath') || '').trim() || undefined;

    const treeProvider = new ConversationTreeDataProvider(storePathOverride);
    const detailProvider = new ConversationDetailProvider(storePathOverride);

    const conversationTreeView = vscode.window.createTreeView('cursorUsageWizard.conversationUsage', {
      treeDataProvider: treeProvider,
    });
    context.subscriptions.push(conversationTreeView);
    conversationTreeView.onDidChangeSelection((e) => {
      const node = e.selection[0];
      detailProvider.setSelection(node?.conversationId);
    });

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        ConversationDetailProvider.viewType,
        detailProvider
      )
    );

    const doRefresh = () => updateStats(statusBarItems, context);

    const refreshConversationViews = () => {
      const conversations = readUsageEvents(storePathOverride);
      treeProvider.refresh();
      detailProvider.setConversations(conversations);
      updateLatestStatusBarItem(
        statusBarItems.latest,
        conversations,
        config.get<boolean>('showLatestInStatusBar', true),
        getActiveConversationId(storePathOverride)
      );
      checkGlobalLimitAlerts(conversations, storePathOverride);
    };

    context.subscriptions.push(
      vscode.commands.registerCommand('cursorUsageWizard.setSessionToken', async () => {
        const token = await vscode.window.showInputBox({
          title: 'Cursor Usage Wizard: Set Session Token',
          prompt:
            'Paste your WorkosCursorSessionToken cookie value from cursor.com (DevTools → Application → Cookies)',
          password: true,
          placeHolder: 'user_xxx%3A%3AeyJ...',
        });
        if (token) {
          await storeSessionToken(context, token);
          doRefresh();
          vscode.window.showInformationMessage('Session token saved.');
        }
      }),
      vscode.commands.registerCommand('cursorUsageWizard.clearSessionToken', async () => {
        await deleteSessionToken(context);
        doRefresh();
        vscode.window.showInformationMessage('Session token cleared.');
      }),
      vscode.commands.registerCommand('cursorUsageWizard.showUsage', () => doRefresh()),
      vscode.commands.registerCommand('cursorUsageWizard.showConversations', () =>
        showConversations(context)
      ),
      vscode.commands.registerCommand(
        'cursorUsageWizard.setConversationLimit',
        (convId?: string) => setConversationLimit(convId, storePathOverride)
      ),
      vscode.commands.registerCommand(
        'cursorUsageWizard.setLimitForConversation',
        (node: ConversationUsage) => {
          if (node?.conversationId) {
            setConversationLimit(node.conversationId, storePathOverride);
          }
        }
      ),
      vscode.commands.registerCommand('cursorUsageWizard.refreshStats', () => {
        doRefresh();
        refreshConversationViews();
      })
    );

    statusBarItems.total.command = 'cursorUsageWizard.refreshStats';
    statusBarItems.total.text = '$(graph) Cursor Usage';
    statusBarItems.total.show();

    try {
      installHooks(context.extensionPath);
    } catch {
      // Non-fatal
    }

    const intervalSeconds = Math.max(config.get<number>('refreshInterval', 30), 5);

    doRefresh();
    refreshConversationViews();

    refreshInterval = setInterval(() => {
      doRefresh();
      refreshConversationViews();
    }, intervalSeconds * 1000);
    context.subscriptions.push({
      dispose: () => {
        if (refreshInterval) clearInterval(refreshInterval);
      },
    });

    if (config.get<boolean>('liveTrackingEnabled', true)) {
      const watcherDisposable = watchUsageFile(storePathOverride, (conversations: ConversationUsage[]) => {
        treeProvider.refresh();
        detailProvider.setConversations(conversations);
        updateLatestStatusBarItem(
          statusBarItems.latest,
          conversations,
          config.get<boolean>('showLatestInStatusBar', true),
          getActiveConversationId(storePathOverride)
        );
        checkGlobalLimitAlerts(conversations, storePathOverride);
      });
      context.subscriptions.push(watcherDisposable);

      const activeWatcher = watchActiveConversationFile(storePathOverride, () => {
        const conversations = readUsageEvents(storePathOverride);
        updateLatestStatusBarItem(
          statusBarItems.latest,
          conversations,
          config.get<boolean>('showLatestInStatusBar', true),
          getActiveConversationId(storePathOverride)
        );
      });
      context.subscriptions.push(activeWatcher);

      try {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const transcriptWatcher = watchAgentTranscripts(
          workspaceRoot,
          storePathOverride,
          (conversationId) => {
            setActiveConversationId(conversationId, storePathOverride);
          }
        );
        context.subscriptions.push(transcriptWatcher);
        if (workspaceRoot) {
          log('Transcript watcher active for current workspace.');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`Transcript watcher skipped: ${msg}`);
      }
    }

    log('Cursor Usage Wizard activated.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Cursor Usage Wizard failed to activate: ${msg}`);
    console.error('[cursor-usage-wizard]', err);
  }
}

export function deactivate(): void {
  if (refreshInterval) clearInterval(refreshInterval);
  statusBarItems?.total.dispose();
  statusBarItems?.auto.dispose();
  statusBarItems?.api.dispose();
  statusBarItems?.onDemand.dispose();
  statusBarItems?.latest.dispose();
}
