import * as vscode from 'vscode';
import { createUsageStatusBarItems } from './handlers/statusBar';
import { updateStats } from './utils/updateStats';
import { installHooks } from './services/hooks';
import { showConversations, setConversationLimit } from './handlers/conversationView';
import {
  setSessionToken as storeSessionToken,
  clearSessionToken as deleteSessionToken,
} from './services/tokenStore';
import { initLogger } from './utils/logger';

let statusBarItems: ReturnType<typeof createUsageStatusBarItems>;
let refreshInterval: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  try {
    initLogger();
    statusBarItems = createUsageStatusBarItems();
    context.subscriptions.push(statusBarItems.total, statusBarItems.auto, statusBarItems.api, statusBarItems.onDemand);

    const doRefresh = () => updateStats(statusBarItems, context);

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
      vscode.commands.registerCommand('cursorUsageWizard.setConversationLimit', () =>
        setConversationLimit()
      ),
      vscode.commands.registerCommand('cursorUsageWizard.refreshStats', () => doRefresh())
    );

    statusBarItems.total.command = 'cursorUsageWizard.refreshStats';
    statusBarItems.total.text = '$(graph) Cursor Usage';
    statusBarItems.total.show();

    try {
      installHooks(context.extensionPath);
    } catch {
      // Non-fatal
    }

    const config = vscode.workspace.getConfiguration('cursorUsageWizard');
    const intervalSeconds = Math.max(config.get<number>('refreshInterval', 30), 5);

    doRefresh();
    refreshInterval = setInterval(doRefresh, intervalSeconds * 1000);
    context.subscriptions.push({
      dispose: () => {
        if (refreshInterval) clearInterval(refreshInterval);
      },
    });
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
}
