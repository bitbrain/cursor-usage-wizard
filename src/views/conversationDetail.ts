import * as vscode from 'vscode';
import type { ConversationUsage } from '../services/usageStore';
import { getLimits } from '../services/usageStore';

export class ConversationDetailProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cursorUsageWizard.conversationDetail';

  private _view: vscode.WebviewView | undefined;
  private _selectedId: string | undefined;
  private _conversations: ConversationUsage[] = [];
  private _storePathOverride: string | undefined;

  constructor(storePathOverride?: string) {
    this._storePathOverride = storePathOverride;
  }

  setStorePathOverride(override: string | undefined): void {
    this._storePathOverride = override;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: false };
    this._updateContent();
  }

  setSelection(conversationId: string | undefined): void {
    this._selectedId = conversationId;
    this._updateContent();
  }

  setConversations(conversations: ConversationUsage[]): void {
    this._conversations = conversations;
    this._updateContent();
  }

  private _updateContent(): void {
    if (!this._view) return;

    const conv = this._selectedId
      ? this._conversations.find((c) => c.conversationId === this._selectedId)
      : undefined;
    const limits = getLimits(this._storePathOverride);
    const limit = this._selectedId ? limits[this._selectedId] : undefined;

    const html = conv
      ? this._buildDetailHtml(conv, limit)
      : '<p style="padding: 0.5rem; color: var(--vscode-descriptionForeground);">Select a conversation above to see usage.</p>';

    this._view.webview.html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 0.5rem; margin: 0; }
  .cost { font-weight: bold; }
  .limit { color: var(--vscode-descriptionForeground); }
  a { color: var(--vscode-textLink-foreground); }
</style></head>
<body>${html}</body>
</html>`;
  }

  private _buildDetailHtml(conv: ConversationUsage, limit: { maxCost?: number; maxEvents?: number } | undefined): string {
    const costStr = `~$${conv.estimatedCost.toFixed(2)}`;
    const limitStr =
      limit?.maxCost != null
        ? ` (limit: $${limit.maxCost})`
        : '';
    const setLimitArgs = encodeURIComponent(JSON.stringify([conv.conversationId]));
    const setLimitHref = `command:cursorUsageWizard.setConversationLimit?${setLimitArgs}`;
    return `
      <p><strong>Conversation</strong></p>
      <p class="cost">${costStr}${limitStr}</p>
      <p>${conv.eventCount} events · ${conv.source}</p>
      <p><a href="${setLimitHref}">Set cost limit</a></p>
    `;
  }
}
