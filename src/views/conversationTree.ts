import * as vscode from 'vscode';
import { readUsageEvents, getLimits, getTitles, GLOBAL_LIMIT_KEY, type ConversationUsage } from '../services/usageStore';

export type ConversationNode = ConversationUsage;

export class ConversationTreeDataProvider implements vscode.TreeDataProvider<ConversationNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ConversationNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private conversations: ConversationUsage[] = [];
  private limits: Record<string, { maxCost?: number; maxEvents?: number }> = {};
  private titles: Record<string, string> = {};
  private storePathOverride: string | undefined;

  constructor(storePathOverride?: string) {
    this.storePathOverride = storePathOverride;
  }

  setStorePathOverride(override: string | undefined): void {
    this.storePathOverride = override;
  }

  refresh(): void {
    this.conversations = readUsageEvents(this.storePathOverride);
    this.limits = getLimits(this.storePathOverride);
    this.titles = getTitles(this.storePathOverride);
    this._onDidChangeTreeData.fire();
  }

  getChildren(element?: ConversationNode): ConversationNode[] {
    if (element) {
      return [];
    }
    return this.conversations;
  }

  getTreeItem(element: ConversationNode): vscode.TreeItem {
    const displayName = this.titles[element.conversationId] || element.conversationId.slice(0, 12) + '...';
    const labelName = displayName.length > 50 ? displayName.slice(0, 47) + '...' : displayName;
    const turnsStr = `${element.turnCount} turn${element.turnCount === 1 ? '' : 's'}`;
    const cents = element.deltaCents ?? element.estimatedTokenCents;
    const costStr =
      cents != null
        ? ` · $${(cents / 100).toFixed(2)}`
        : '';
    const eventsStr = `${element.eventCount} events`;
    const sourceTag = element.source === 'tab' ? '[tab]' : '[agent]';
    const limit = this.limits[element.conversationId] || this.limits[GLOBAL_LIMIT_KEY];
    const limitParts: string[] = [];
    if (limit?.maxCost != null) limitParts.push(`$${limit.maxCost}`);
    if (limit?.maxEvents != null) limitParts.push(`${limit.maxEvents} events`);
    const limitStr = limitParts.length > 0 ? ` limit ${limitParts.join(' / ')}` : '';

    const item = new vscode.TreeItem(
      `${labelName} ${turnsStr}${costStr} (${eventsStr}) ${sourceTag}${limitStr}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.contextValue = 'conversationNode';
    const costTooltip =
      element.deltaCents != null
        ? `$${(element.deltaCents / 100).toFixed(2)} (from Cursor billing)`
        : element.estimatedTokenCents != null
          ? `~$${(element.estimatedTokenCents / 100).toFixed(2)}`
          : 'cost unknown until session ends';
    item.tooltip = `${displayName}\n${element.conversationId}\n${turnsStr} · ${costTooltip} · ${eventsStr} · ${element.source}${limitStr}`;
    item.description = eventsStr;
    item.iconPath = new vscode.ThemeIcon(
      element.source === 'tab' ? 'edit' : 'comment-discussion'
    );
    return item;
  }
}
