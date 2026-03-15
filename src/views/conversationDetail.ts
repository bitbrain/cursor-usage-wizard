import * as vscode from 'vscode';
import type { ConversationUsage } from '../services/usageStore';
import { getLimits, getTitles, GLOBAL_LIMIT_KEY } from '../services/usageStore';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
    const limit = this._selectedId
      ? limits[this._selectedId] || limits[GLOBAL_LIMIT_KEY]
      : undefined;
    const titles = getTitles(this._storePathOverride);
    const title = this._selectedId ? titles[this._selectedId] : undefined;

    const html = conv
      ? this._buildDetailHtml(conv, limit, title)
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

  private _buildDetailHtml(
    conv: ConversationUsage,
    limit: { maxCost?: number; maxEvents?: number } | undefined,
    title?: string
  ): string {
    const heading = title || conv.conversationId.slice(0, 12) + '...';
    const turnsStr = `${conv.turnCount} LLM turn${conv.turnCount === 1 ? '' : 's'}`;
    const costLine =
      conv.deltaCents != null
        ? `<p class="cost">$${(conv.deltaCents / 100).toFixed(2)} (from Cursor billing)</p>`
        : conv.estimatedTokenCents != null
          ? `<p class="cost">~$${(conv.estimatedTokenCents / 100).toFixed(2)}</p><p class="limit">Token-based estimate; does not account for caching.</p>`
          : '<p class="limit">Cost unknown until session ends.</p>';
    const limitParts: string[] = [];
    if (limit?.maxCost != null) limitParts.push(`$${limit.maxCost}`);
    if (limit?.maxEvents != null) limitParts.push(`${limit.maxEvents} events`);
    const limitStr = limitParts.length > 0 ? ` (limit: ${limitParts.join(' / ')})` : '';
    const setLimitArgs = encodeURIComponent(JSON.stringify([conv.conversationId]));
    const setLimitHref = `command:cursorUsageWizard.setConversationLimit?${setLimitArgs}`;
    return `
      <p><strong>${escapeHtml(heading)}</strong></p>
      <p>${turnsStr} · ${conv.eventCount} events · ${conv.source}${limitStr}</p>
      ${costLine}
      <p><a href="${setLimitHref}">Set limit</a></p>
    `;
  }
}
