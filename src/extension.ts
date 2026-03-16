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
import { snapshotStart, recordEnd } from './services/sessionCosts';
import { setWorkspaceRoot } from './services/transcriptTokens';
import { getUsageStorePath } from './utils/constants';

let statusBarItems: ReturnType<typeof createUsageStatusBarItems>;
let refreshInterval: NodeJS.Timeout | undefined;
/** Current API pool usedCents from last cursor.com fetch (for session cost snapshots). */
let lastKnownUsedCents: number | undefined;
/** Last active conversation ID (for session boundary: recordEnd previous, snapshotStart new). */
let lastActiveConversationId: string | undefined;

/** Activity-triggered refresh throttle: timestamp of last completed fetch (for cooldown). */
let lastFetchTime = 0;
/** If true, run one more activity refresh after the current one completes. */
let pendingActivityRefresh = false;
/** Single timeout that runs a refresh at end of cooldown. */
let activityRefreshScheduled: ReturnType<typeof setTimeout> | undefined;
/** Debounce timer: after usage.jsonl activity, wait before requesting refresh. */
let activityDebounceTimer: ReturnType<typeof setTimeout> | undefined;
/** True while doRefresh() is in flight (prevents parallel activity refreshes). */
let refreshInFlight = false;

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
  const maxCostCents = global.maxCost != null ? Math.round(global.maxCost * 100) : null;
  for (const c of conversations) {
    const overCost =
      maxCostCents != null && c.deltaCents != null && c.deltaCents >= maxCostCents;
    const overEvents = global.maxEvents != null && c.eventCount >= global.maxEvents;
    if (!overCost && !overEvents) continue;
    if (notifiedOverLimit.has(c.conversationId)) continue;
    notifiedOverLimit.add(c.conversationId);
    const name = titles[c.conversationId] || c.conversationId.slice(0, 12) + '...';
    const costStr =
      c.deltaCents != null ? `$${(c.deltaCents / 100).toFixed(2)}` : '?';
    const msg =
      overCost && overEvents
        ? `"${name}" has exceeded the global limit (${costStr} >= $${global.maxCost}, ${c.eventCount} events >= ${global.maxEvents}).`
        : overCost
          ? `"${name}" has exceeded the global cost limit (${costStr} >= $${global.maxCost}).`
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
      statusBarItems.latest,
      statusBarItems.water,
      statusBarItems.co2
    );

    const config = vscode.workspace.getConfiguration('cursorUsageWizard');
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const storePathOverride =
      (config.get<string>('usageStorePath') || '').trim() ||
      (workspaceRoot ? getUsageStorePath(undefined, workspaceRoot) : undefined);

    setWorkspaceRoot(workspaceRoot);

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

    const doRefresh = async (): Promise<number | undefined> => {
      const usedCents = await updateStats(statusBarItems, context, storePathOverride);
      if (usedCents !== undefined) lastKnownUsedCents = usedCents;
      return usedCents;
    };

    /** When skipLatestStatusBar is true, do not update latest/water/co2 (e.g. right after doRefresh, since updateStatusBar already did). */
    const refreshConversationViews = (skipLatestStatusBar?: boolean) => {
      const conversations = readUsageEvents(storePathOverride);
      treeProvider.refresh();
      detailProvider.setConversations(conversations);
      if (!skipLatestStatusBar) {
        updateLatestStatusBarItem(
          statusBarItems.latest,
          statusBarItems.water,
          statusBarItems.co2,
          conversations,
          config.get<boolean>('showLatestInStatusBar', true),
          getActiveConversationId(storePathOverride)
        );
      }
      checkGlobalLimitAlerts(conversations, storePathOverride);
    };

    const activityRefreshCooldownMs = Math.min(
      120_000,
      Math.max(5_000, (config.get<number>('activityRefreshCooldownSeconds', 15) ?? 15) * 1000)
    );
    const activityRefreshDebounceMs = Math.min(
      10_000,
      Math.max(1_000, config.get<number>('activityRefreshDebounceMs', 3000) ?? 3000)
    );

    const runActivityRefresh = () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      void doRefresh().then((usedCents) => {
        refreshInFlight = false;
        if (usedCents !== undefined) lastFetchTime = Date.now();
        refreshConversationViews(true);
        if (pendingActivityRefresh) {
          pendingActivityRefresh = false;
          requestActivityRefresh();
        }
      });
    };

    const requestActivityRefresh = () => {
      if (refreshInFlight) {
        pendingActivityRefresh = true;
        return;
      }
      const elapsed = Date.now() - lastFetchTime;
      if (elapsed < activityRefreshCooldownMs) {
        pendingActivityRefresh = true;
        if (activityRefreshScheduled === undefined) {
          activityRefreshScheduled = setTimeout(() => {
            activityRefreshScheduled = undefined;
            runActivityRefresh();
          }, activityRefreshCooldownMs - elapsed);
        }
        return;
      }
      runActivityRefresh();
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
        void doRefresh().then(() => refreshConversationViews(true));
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

    void doRefresh().then((usedCents) => {
      if (usedCents !== undefined) lastFetchTime = Date.now();
      refreshConversationViews(true);
      const current = getActiveConversationId(storePathOverride);
      if (current != null && lastActiveConversationId == null && lastKnownUsedCents != null) {
        snapshotStart(current, lastKnownUsedCents, storePathOverride);
        lastActiveConversationId = current;
      }
    });

    refreshInterval = setInterval(() => {
      void doRefresh().then((usedCents) => {
        if (usedCents !== undefined) lastFetchTime = Date.now();
        refreshConversationViews(true);
      });
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
          statusBarItems.water,
          statusBarItems.co2,
          conversations,
          config.get<boolean>('showLatestInStatusBar', true),
          getActiveConversationId(storePathOverride)
        );
        checkGlobalLimitAlerts(conversations, storePathOverride);
        if (activityDebounceTimer !== undefined) clearTimeout(activityDebounceTimer);
        activityDebounceTimer = setTimeout(() => {
          activityDebounceTimer = undefined;
          requestActivityRefresh();
        }, activityRefreshDebounceMs);
      });
      context.subscriptions.push(watcherDisposable);
      context.subscriptions.push({
        dispose: () => {
          if (activityRefreshScheduled !== undefined) {
            clearTimeout(activityRefreshScheduled);
            activityRefreshScheduled = undefined;
          }
          if (activityDebounceTimer !== undefined) {
            clearTimeout(activityDebounceTimer);
            activityDebounceTimer = undefined;
          }
        },
      });

      const activeWatcher = watchActiveConversationFile(storePathOverride, () => {
        const newId = getActiveConversationId(storePathOverride);
        const changedConversation =
          newId != null && lastActiveConversationId !== newId;
        if (
          lastActiveConversationId != null &&
          changedConversation
        ) {
          recordEnd(lastActiveConversationId, lastKnownUsedCents ?? 0, storePathOverride);
        }
        void doRefresh().then((usedCents) => {
          if (usedCents !== undefined) lastFetchTime = Date.now();
          if (changedConversation && newId != null) {
            snapshotStart(newId, usedCents ?? lastKnownUsedCents ?? 0, storePathOverride);
            lastActiveConversationId = newId;
          }
          refreshConversationViews(true);
        });
      });
      context.subscriptions.push(activeWatcher);

      try {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const transcriptWatcher = watchAgentTranscripts(
          workspaceRoot,
          storePathOverride,
          (conversationId) => {
            const changedConversation = lastActiveConversationId !== conversationId;
            if (
              lastActiveConversationId != null &&
              changedConversation
            ) {
              recordEnd(lastActiveConversationId, lastKnownUsedCents ?? 0, storePathOverride);
            }
            void doRefresh().then((usedCents) => {
              if (usedCents !== undefined) lastFetchTime = Date.now();
              if (changedConversation) {
                snapshotStart(
                  conversationId,
                  usedCents ?? lastKnownUsedCents ?? 0,
                  storePathOverride
                );
                lastActiveConversationId = conversationId;
              }
              setActiveConversationId(conversationId, storePathOverride);
              refreshConversationViews(true);
            });
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
