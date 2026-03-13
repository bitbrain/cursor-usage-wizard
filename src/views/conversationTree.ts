import * as vscode from 'vscode';
import { readUsageEvents, getLimits, type ConversationUsage } from '../services/usageStore';

export type ConversationNode = ConversationUsage;

export class ConversationTreeDataProvider implements vscode.TreeDataProvider<ConversationNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ConversationNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private conversations: ConversationUsage[] = [];
  private limits: Record<string, { maxCost?: number; maxEvents?: number }> = {};
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
    this._onDidChangeTreeData.fire();
  }

  getChildren(element?: ConversationNode): ConversationNode[] {
    if (element) {
      return [];
    }
    return this.conversations;
  }

  getTreeItem(element: ConversationNode): vscode.TreeItem {
    const short = element.conversationId.slice(0, 12);
    const costStr = `~$${element.estimatedCost.toFixed(2)}`;
    const eventsStr = `${element.eventCount} events`;
    const sourceTag = element.source === 'tab' ? '[tab]' : '[agent]';
    const limit = this.limits[element.conversationId];
    const limitStr = limit?.maxCost != null ? ` limit $${limit.maxCost}` : '';

    const item = new vscode.TreeItem(
      `${short}... ${costStr} (${eventsStr}) ${sourceTag}${limitStr}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.contextValue = 'conversationNode';
    item.tooltip = `${element.conversationId}\n${costStr} · ${eventsStr} · ${element.source}${limitStr}`;
    item.description = eventsStr;
    item.iconPath = new vscode.ThemeIcon(
      element.source === 'tab' ? 'edit' : 'comment-discussion'
    );
    return item;
  }
}
