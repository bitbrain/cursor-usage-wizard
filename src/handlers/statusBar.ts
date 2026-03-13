import * as vscode from 'vscode';
import type { NewUsageResponse } from '../services/api';
import type { ConversationUsage } from '../services/usageStore';

export function createStatusBarItem(): vscode.StatusBarItem {
  return vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
}

/** Four separate items: total %, auto (included) %, API pool, on-demand (each with its own hover). */
export function createUsageStatusBarItems(): {
  total: vscode.StatusBarItem;
  auto: vscode.StatusBarItem;
  api: vscode.StatusBarItem;
  onDemand: vscode.StatusBarItem;
} {
  return {
    total: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103),
    auto: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102),
    api: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101),
    onDemand: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100),
  };
}

export function getStatusBarColor(usagePercent: number): vscode.ThemeColor | undefined {
  if (usagePercent >= 90) return new vscode.ThemeColor('statusBarItem.errorBackground');
  if (usagePercent >= 75) return new vscode.ThemeColor('statusBarItem.warningBackground');
  return undefined;
}

export function createMarkdownTooltip(lines: string[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = true;
  md.appendMarkdown(lines.join('\n\n'));
  return md;
}

function fmtDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtPct(p: number): string {
  return `${p.toFixed(2)}%`;
}

export interface UsageStatusBarItems {
  total: vscode.StatusBarItem;
  auto: vscode.StatusBarItem;
  api: vscode.StatusBarItem;
  onDemand: vscode.StatusBarItem;
}

function setNoUsageState(
  items: UsageStatusBarItems,
  authOkNoUsage: boolean
): void {
  if (authOkNoUsage) {
    items.total.text = '$(graph) Cursor Usage: —';
    items.total.tooltip = new vscode.MarkdownString(
      'Usage data could not be read from the dashboard. Token is valid. Try again later or check the **Cursor Usage Wizard** output for details.'
    );
    items.total.command = 'cursorUsageWizard.refreshStats';
  } else {
    items.total.text = '$(key) Cursor Usage (set session token)';
    items.total.tooltip = new vscode.MarkdownString(
      'Unable to fetch usage. **Click** to set or update your `WorkosCursorSessionToken` cookie from cursor.com'
    );
    items.total.command = 'cursorUsageWizard.setSessionToken';
  }
  items.total.color = undefined;
  items.total.show();
  items.auto.hide();
  items.api.hide();
  items.onDemand.hide();
}

export function updateStatusBar(
  items: UsageStatusBarItems,
  usage: NewUsageResponse | undefined,
  conversations?: ConversationUsage[],
  showPerConversation?: boolean,
  /** When true, token worked but usage could not be parsed (show "unavailable", do not prompt for token). */
  authOkNoUsage?: boolean
): void {
  if (!usage) {
    setNoUsageState(items, !!authOkNoUsage);
    return;
  }

  const pct = usage.totalPercent ?? usage.apiPool.percent;
  const pctStr = fmtPct(pct);
  const color = getStatusBarColor(pct);

  // Total % — icon + value, tooltip with full summary
  items.total.text = `$(graph) ${pctStr}`;
  items.total.tooltip = buildFullTooltip(usage, conversations, showPerConversation);
  items.total.color = color;
  items.total.command = 'cursorUsageWizard.refreshStats';
  items.total.show();

  // Auto (included) % — Auto + Composer usage, only when present
  if (usage.autoComposerPool != null) {
    const autoPct = fmtPct(usage.autoComposerPool.percent);
    items.auto.text = `$(sparkle) ${autoPct}`;
    items.auto.tooltip = buildAutoTooltip(usage.autoComposerPool.percent);
    items.auto.color = getStatusBarColor(usage.autoComposerPool.percent);
    items.auto.command = 'cursorUsageWizard.refreshStats';
    items.auto.show();
  } else {
    items.auto.hide();
  }

  // API pool — icon + $ used/limit, tooltip with API + Auto/Composer
  const apiStr = `${fmtDollars(usage.apiPool.usedCents)}/${fmtDollars(usage.apiPool.limitCents)}`;
  items.api.text = `$(circuit-board) ${apiStr}`;
  items.api.tooltip = buildApiTooltip(usage);
  items.api.color = getStatusBarColor(usage.apiPool.percent);
  items.api.command = 'cursorUsageWizard.refreshStats';
  items.api.show();

  // On-demand — icon + $ used[/limit], tooltip with OD details
  const od = usage.onDemand;
  if (od) {
    const odStr = od.limitCents != null
      ? `${fmtDollars(od.usedCents)}/${fmtDollars(od.limitCents)}`
      : fmtDollars(od.usedCents);
    items.onDemand.text = `$(credit-card) ${odStr}`;
    items.onDemand.tooltip = buildOnDemandTooltip(od);
    items.onDemand.color = od.limitCents != null ? getStatusBarColor((od.usedCents / od.limitCents) * 100) : undefined;
    items.onDemand.command = 'cursorUsageWizard.refreshStats';
    items.onDemand.show();
  } else {
    items.onDemand.hide();
  }
}

function buildFullTooltip(
  usage: NewUsageResponse,
  conversations?: ConversationUsage[],
  showPerConversation?: boolean
): vscode.MarkdownString {
  const pct = usage.totalPercent ?? usage.apiPool.percent;
  const lines = [
    '**Cursor Usage**',
    '',
    `Total: ${fmtPct(pct)}`,
    '',
    `API pool: ${fmtPct(usage.apiPool.percent)} — ${fmtDollars(usage.apiPool.usedCents)} / ${fmtDollars(usage.apiPool.limitCents)}`,
  ];
  if (usage.autoComposerPool != null) {
    lines.push('', `Auto + Composer: ${fmtPct(usage.autoComposerPool.percent)}`);
  }
  if (usage.onDemand) {
    const od = usage.onDemand;
    lines.push(
      '',
      od.limitCents != null
        ? `On-demand: ${fmtDollars(od.usedCents)} / ${fmtDollars(od.limitCents)}`
        : `On-demand: ${fmtDollars(od.usedCents)} (unlimited)`
    );
  }
  if (usage.resetDate) {
    lines.push('', `Resets: ${usage.resetDate}`);
  }
  if (showPerConversation && conversations && conversations.length > 0) {
    lines.push('', '**Per-conversation (estimated)**');
    for (const c of conversations.slice(0, 5)) {
      const short = c.conversationId.slice(0, 8);
      lines.push(`- ${short}... ${c.eventCount} events, ~$${c.estimatedCost.toFixed(2)}`);
    }
    if (conversations.length > 5) {
      lines.push(`- ... and ${conversations.length - 5} more`);
    }
  }
  return createMarkdownTooltip(lines);
}

function buildAutoTooltip(percent: number): vscode.MarkdownString {
  return createMarkdownTooltip([
    '**Auto + Composer (included)**',
    '',
    `${fmtPct(percent)} of included usage used.`,
  ]);
}

function buildApiTooltip(usage: NewUsageResponse): vscode.MarkdownString {
  const lines = [
    '**API pool**',
    '',
    `${fmtPct(usage.apiPool.percent)} — ${fmtDollars(usage.apiPool.usedCents)} / ${fmtDollars(usage.apiPool.limitCents)}`,
  ];
  if (usage.autoComposerPool != null) {
    lines.push('', `Auto + Composer: ${fmtPct(usage.autoComposerPool.percent)}`);
  }
  if (usage.resetDate) {
    lines.push('', `Resets: ${usage.resetDate}`);
  }
  return createMarkdownTooltip(lines);
}

function buildOnDemandTooltip(od: { usedCents: number; limitCents: number | null }): vscode.MarkdownString {
  const lines = [
    '**On-demand usage**',
    '',
    od.limitCents != null
      ? `${fmtDollars(od.usedCents)} / ${fmtDollars(od.limitCents)}`
      : `${fmtDollars(od.usedCents)} (unlimited)`,
  ];
  return createMarkdownTooltip(lines);
}
