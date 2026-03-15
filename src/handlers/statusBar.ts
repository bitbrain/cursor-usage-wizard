import * as vscode from 'vscode';
import type { NewUsageResponse } from '../services/api';
import type { ConversationUsage } from '../services/usageStore';

// --- Animation state (tween + red pulse) ---
const TWEEN_DURATION_MS = 300;
const TWEEN_STEP_MS = 16;

const PULSE_FADE_MS = 1000;
const PULSE_HOLD_MS = 500;
const PULSE_FADE_STEP_MS = 16;

let lastValues: {
  totalPct?: number;
  autoPct?: number;
  apiUsedCents?: number;
  apiLimitCents?: number;
  onDemandUsedCents?: number;
  latestCost?: number;
  latestConvId?: string;
  /** True when latest segment shows real $ (deltaCents); false when showing turn count. */
  latestIsDollars?: boolean;
  /** True when showing token estimate instead of Cursor billing. */
  latestIsEst?: boolean;
} = {};
const tweenTimeouts: Record<string, NodeJS.Timeout[]> = Object.create(null);
/** Pulse: timeouts + item + restoreColor so we can restore when cleared or done. */
const pulseTimeouts: Record<string, {
  flash?: NodeJS.Timeout;
  fadeStart?: NodeJS.Timeout;
  fadeSteps?: NodeJS.Timeout[];
  item?: vscode.StatusBarItem;
  restoreColor?: vscode.ThemeColor | string | undefined;
}> = Object.create(null);

function clearTweenTimeoutsForSegment(segmentKey: string): void {
  const tids = tweenTimeouts[segmentKey];
  if (tids) {
    for (const t of tids) clearTimeout(t);
    tweenTimeouts[segmentKey] = [];
  }
}

function restorePulseSegment(
  pulse: { item?: vscode.StatusBarItem; restoreColor?: vscode.ThemeColor | string | undefined }
): void {
  if (pulse.item) pulse.item.color = pulse.restoreColor;
}

function clearSegmentTimeouts(segmentKey: string): void {
  clearTweenTimeoutsForSegment(segmentKey);
  const pulse = pulseTimeouts[segmentKey];
  if (pulse) {
    if (pulse.flash) clearTimeout(pulse.flash);
    if (pulse.fadeStart) clearTimeout(pulse.fadeStart);
    if (pulse.fadeSteps) {
      for (const t of pulse.fadeSteps) clearTimeout(t);
    }
    restorePulseSegment(pulse);
    delete pulseTimeouts[segmentKey];
  }
}

function clearAllAnimationTimeouts(): void {
  for (const key of Object.keys(tweenTimeouts)) clearSegmentTimeouts(key);
  for (const key of Object.keys(pulseTimeouts)) {
    if (key === 'latest') continue; // Preserve latest pulse so 1s fade can complete
    const pulse = pulseTimeouts[key];
    if (pulse.flash) clearTimeout(pulse.flash);
    if (pulse.fadeStart) clearTimeout(pulse.fadeStart);
    if (pulse.fadeSteps) {
      for (const t of pulse.fadeSteps) clearTimeout(t);
    }
    restorePulseSegment(pulse);
    delete pulseTimeouts[key];
  }
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function runTween(
  segmentKey: string,
  start: number,
  end: number,
  durationMs: number,
  formatter: (n: number) => string,
  onStep: (formatted: string) => void,
  onDone?: () => void
): void {
  clearTweenTimeoutsForSegment(segmentKey);
  const list: NodeJS.Timeout[] = [];
  tweenTimeouts[segmentKey] = list;
  const startTime = Date.now();
  const step = (): void => {
    const elapsed = Date.now() - startTime;
    const t = Math.min(1, elapsed / durationMs);
    const eased = easeOutQuad(t);
    const value = start + (end - start) * eased;
    onStep(formatter(value));
    if (t < 1) {
      const id = setTimeout(step, TWEEN_STEP_MS) as unknown as NodeJS.Timeout;
      list.push(id);
    } else {
      list.length = 0;
      onDone?.();
    }
  };
  step();
}

function runTweenCustom(
  segmentKey: string,
  durationMs: number,
  formatter: (t: number) => string,
  onStep: (formatted: string) => void,
  onDone?: () => void
): void {
  clearTweenTimeoutsForSegment(segmentKey);
  const list: NodeJS.Timeout[] = [];
  tweenTimeouts[segmentKey] = list;
  const startTime = Date.now();
  const step = (): void => {
    const elapsed = Date.now() - startTime;
    const t = Math.min(1, elapsed / durationMs);
    const eased = easeOutQuad(t);
    onStep(formatter(eased));
    if (t < 1) {
      const id = setTimeout(step, TWEEN_STEP_MS) as unknown as NodeJS.Timeout;
      list.push(id);
    } else {
      list.length = 0;
      onDone?.();
    }
  };
  step();
}

/** Same as 75% limit (warning) — pink-ish "over limit" color at 100%. */
const PULSE_WARNING_THEME = new vscode.ThemeColor('statusBarItem.warningBackground');
/** Fade: from warning-like hex (can't read theme as hex) to end color. */
const PULSE_FADE_START_HEX = '#d4a574';
const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;

function getDefaultStatusBarForegroundHex(): string {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return '#424242';
    case vscode.ColorThemeKind.HighContrastLight:
      return '#1f1f1f';
    case vscode.ColorThemeKind.HighContrast:
      return '#ffffff';
    case vscode.ColorThemeKind.Dark:
    default:
      return '#d4d4d4';
  }
}

/** If item currently has a hex color, use it as fade end (theme may have resolved it); else fallback. */
function getFadeEndHex(item: vscode.StatusBarItem): string {
  const current = item.color;
  return typeof current === 'string' && HEX_COLOR_REGEX.test(current)
    ? current
    : getDefaultStatusBarForegroundHex();
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b]
    .map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0'))
    .join('');
}

function mixHex(hex1: string, hex2: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

function startPulse(
  item: vscode.StatusBarItem,
  segmentKey: string,
  restoreColor: vscode.ThemeColor | string | undefined
): void {
  const fadeEndHex = getFadeEndHex(item);
  const existing = pulseTimeouts[segmentKey];
  if (existing) {
    if (existing.flash) clearTimeout(existing.flash);
    if (existing.fadeStart) clearTimeout(existing.fadeStart);
    if (existing.fadeSteps) {
      for (const t of existing.fadeSteps) clearTimeout(t);
    }
    restorePulseSegment(existing);
  }
  item.color = PULSE_WARNING_THEME;
  const pulseState = {
    flash: undefined as NodeJS.Timeout | undefined,
    fadeStart: undefined as NodeJS.Timeout | undefined,
    fadeSteps: undefined as NodeJS.Timeout[] | undefined,
    item,
    restoreColor,
  };
  pulseTimeouts[segmentKey] = pulseState;

  pulseState.fadeStart = setTimeout(() => {
    const startTime = Date.now();
    const steps: NodeJS.Timeout[] = [];
    const step = (): void => {
      const elapsed = Date.now() - startTime;
      const t = Math.min(1, elapsed / PULSE_FADE_MS);
      item.color = mixHex(PULSE_FADE_START_HEX, fadeEndHex, t);
      if (t < 1) {
        steps.push(setTimeout(step, PULSE_FADE_STEP_MS) as unknown as NodeJS.Timeout);
      } else {
        const p = pulseTimeouts[segmentKey];
        if (p) p.fadeSteps = undefined;
        delete pulseTimeouts[segmentKey];
        item.color = restoreColor;
      }
    };
    const p = pulseTimeouts[segmentKey];
    if (p) p.fadeSteps = steps;
    step();
  }, PULSE_HOLD_MS);
}

export function createStatusBarItem(): vscode.StatusBarItem {
  return vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
}

// Priorities 0–4 so this extension's items stay grouped and appear last (rightmost) in the status bar.
const SB_PRIORITY_GROUP = { total: 4, auto: 3, api: 2, onDemand: 1, latest: 0 };

/** Five separate items: total %, auto %, API pool, on-demand, and latest conversation (each with its own hover). */
export function createUsageStatusBarItems(): {
  total: vscode.StatusBarItem;
  auto: vscode.StatusBarItem;
  api: vscode.StatusBarItem;
  onDemand: vscode.StatusBarItem;
  latest: vscode.StatusBarItem;
} {
  return {
    total: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_PRIORITY_GROUP.total),
    auto: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_PRIORITY_GROUP.auto),
    api: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_PRIORITY_GROUP.api),
    onDemand: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_PRIORITY_GROUP.onDemand),
    latest: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_PRIORITY_GROUP.latest),
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
  latest: vscode.StatusBarItem;
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
  items.latest.hide();
}

export function updateStatusBar(
  items: UsageStatusBarItems,
  usage: NewUsageResponse | undefined,
  conversations?: ConversationUsage[],
  showPerConversation?: boolean,
  /** When true, token worked but usage could not be parsed (show "unavailable", do not prompt for token). */
  authOkNoUsage?: boolean,
  /** When true, show current/latest conversation cost in status bar (default true). */
  showLatestInStatusBar?: boolean,
  /** When set and present in conversations, show this as "Current conversation" instead of latest. */
  activeConversationId?: string
): void {
  if (!usage) {
    clearAllAnimationTimeouts();
    setNoUsageState(items, !!authOkNoUsage);
    return;
  }

  const config = vscode.workspace.getConfiguration('cursorUsageWizard');
  const animationsOn = config.get<boolean>('usageAnimations', true);
  clearAllAnimationTimeouts();

  const pct = usage.totalPercent ?? usage.apiPool.percent;
  const pctStr = fmtPct(pct);
  const totalColor = getStatusBarColor(pct);

  items.total.tooltip = buildFullTooltip(usage, conversations, showPerConversation);
  items.total.command = 'cursorUsageWizard.refreshStats';
  if (!animationsOn || lastValues.totalPct === undefined) {
    items.total.text = `$(graph) ${pctStr}`;
    items.total.color = totalColor;
    lastValues.totalPct = pct;
  } else if (lastValues.totalPct !== pct) {
    startPulse(items.total, 'total', totalColor);
    runTween('total', lastValues.totalPct, pct, TWEEN_DURATION_MS, fmtPct, (formatted) => {
      items.total.text = `$(graph) ${formatted}`;
    }, () => {
      lastValues.totalPct = pct;
    });
  }
  items.total.show();

  // Auto (included) % — Auto + Composer usage, only when present
  if (usage.autoComposerPool != null) {
    const autoPct = usage.autoComposerPool.percent;
    const autoPctStr = fmtPct(autoPct);
    const autoColor = getStatusBarColor(autoPct);
    items.auto.tooltip = buildAutoTooltip(autoPct);
    items.auto.command = 'cursorUsageWizard.refreshStats';
    if (!animationsOn || lastValues.autoPct === undefined) {
      items.auto.text = `$(sparkle) ${autoPctStr}`;
      items.auto.color = autoColor;
      lastValues.autoPct = autoPct;
    } else if (lastValues.autoPct !== autoPct) {
      startPulse(items.auto, 'auto', autoColor);
      runTween('auto', lastValues.autoPct, autoPct, TWEEN_DURATION_MS, fmtPct, (formatted) => {
        items.auto.text = `$(sparkle) ${formatted}`;
      }, () => {
        lastValues.autoPct = autoPct;
      });
    }
    items.auto.show();
  } else {
    lastValues.autoPct = undefined;
    items.auto.hide();
  }

  // API pool — icon + $ used/limit
  const apiUsed = usage.apiPool.usedCents;
  const apiLimit = usage.apiPool.limitCents;
  const apiStr = `${fmtDollars(apiUsed)}/${fmtDollars(apiLimit)}`;
  const apiColor = getStatusBarColor(usage.apiPool.percent);
  items.api.tooltip = buildApiTooltip(usage);
  items.api.command = 'cursorUsageWizard.refreshStats';
  if (!animationsOn || lastValues.apiUsedCents === undefined) {
    items.api.text = `$(circuit-board) ${apiStr}`;
    items.api.color = apiColor;
    lastValues.apiUsedCents = apiUsed;
    lastValues.apiLimitCents = apiLimit;
  } else if (lastValues.apiUsedCents !== apiUsed || lastValues.apiLimitCents !== apiLimit) {
    startPulse(items.api, 'api', apiColor);
    const startUsed = lastValues.apiUsedCents ?? apiUsed;
    const startLimit = lastValues.apiLimitCents ?? apiLimit;
    runTweenCustom('api', TWEEN_DURATION_MS, (t) => {
      const u = Math.round(startUsed + (apiUsed - startUsed) * t);
      const l = Math.round(startLimit + (apiLimit - startLimit) * t);
      return `${fmtDollars(u)}/${fmtDollars(l)}`;
    }, (formatted) => {
      items.api.text = `$(circuit-board) ${formatted}`;
    }, () => {
      lastValues.apiUsedCents = apiUsed;
      lastValues.apiLimitCents = apiLimit;
    });
  }
  items.api.show();

  // On-demand — icon + $ used[/limit]
  const od = usage.onDemand;
  if (od) {
    const odUsed = od.usedCents;
    const odStr = od.limitCents != null
      ? `${fmtDollars(odUsed)}/${fmtDollars(od.limitCents)}`
      : fmtDollars(odUsed);
    const odColor = od.limitCents != null ? getStatusBarColor((odUsed / od.limitCents) * 100) : undefined;
    items.onDemand.tooltip = buildOnDemandTooltip(od);
    items.onDemand.command = 'cursorUsageWizard.refreshStats';
    if (!animationsOn || lastValues.onDemandUsedCents === undefined) {
      items.onDemand.text = `$(credit-card) ${odStr}`;
      items.onDemand.color = odColor;
      lastValues.onDemandUsedCents = odUsed;
    } else if (lastValues.onDemandUsedCents !== odUsed) {
      startPulse(items.onDemand, 'onDemand', odColor);
      const startUsed = lastValues.onDemandUsedCents;
      const endLimit = od.limitCents;
      runTween('onDemand', startUsed, odUsed, TWEEN_DURATION_MS, (cents) => {
        const c = Math.round(cents);
        return endLimit != null ? `${fmtDollars(c)}/${fmtDollars(endLimit)}` : fmtDollars(c);
      }, (formatted) => {
        items.onDemand.text = `$(credit-card) ${formatted}`;
      }, () => {
        lastValues.onDemandUsedCents = odUsed;
      });
    }
    items.onDemand.show();
  } else {
    lastValues.onDemandUsedCents = undefined;
    items.onDemand.hide();
  }

  // Current/latest conversation: real cost (deltaCents), token estimate, or turn count
  if (showLatestInStatusBar !== false && conversations && conversations.length > 0) {
    const latest = conversations[0];
    const activeConv = activeConversationId
      ? conversations.find((c) => c.conversationId === activeConversationId)
      : undefined;
    const conv = activeConv ?? latest;
    const deltaCents = conv.deltaCents;
    const estimatedCents = conv.estimatedTokenCents;
    const cents = deltaCents ?? estimatedCents;
    const isDollars = cents != null;
    const isEst = deltaCents == null && estimatedCents != null;
    const displayNum = isDollars ? cents! / 100 : conv.turnCount;
    const displayStr = isDollars
      ? `$${displayNum.toFixed(2)}`
      : `${conv.turnCount} turn${conv.turnCount === 1 ? '' : 's'}`;
    const label = activeConv ? 'Current conversation' : 'Latest conversation';
    const tooltipDetail = isDollars
      ? isEst
        ? `Token-based estimate: ${displayStr}`
        : `Cost from Cursor billing: ${displayStr}`
      : `${conv.turnCount} LLM turns (cost unknown until session ends)`;
    items.latest.tooltip = new vscode.MarkdownString(
      `**${label}**\n\n${conv.conversationId.slice(0, 16)}...\n${tooltipDetail} · ${conv.eventCount} events`
    );
    items.latest.command = 'cursorUsageWizard.refreshStats';
    const latestColor = getDefaultStatusBarForegroundHex();
    const sameConv = lastValues.latestConvId === conv.conversationId;
    const sameMode = lastValues.latestIsDollars === isDollars;
    if (!animationsOn || lastValues.latestCost === undefined || !sameConv || !sameMode) {
      items.latest.text = `$(comment-discussion) ${displayStr}`;
      if (!pulseTimeouts['latest']) items.latest.color = latestColor;
      lastValues.latestCost = displayNum;
      lastValues.latestConvId = conv.conversationId;
      lastValues.latestIsDollars = isDollars;
      lastValues.latestIsEst = isEst;
    } else if (lastValues.latestCost !== displayNum) {
      if (!pulseTimeouts['latest']) startPulse(items.latest, 'latest', latestColor);
      const formatter = isDollars
        ? (n: number) => `$${n.toFixed(2)}`
        : (n: number) => `${Math.round(n)} turn${Math.round(n) === 1 ? '' : 's'}`;
      runTween('latest', lastValues.latestCost, displayNum, TWEEN_DURATION_MS, formatter, (formatted) => {
        items.latest.text = `$(comment-discussion) ${formatted}`;
      }, () => {
        lastValues.latestCost = displayNum;
        lastValues.latestConvId = conv.conversationId;
        lastValues.latestIsDollars = isDollars;
        lastValues.latestIsEst = isEst;
      });
    }
    items.latest.show();
  } else {
    lastValues.latestCost = undefined;
    lastValues.latestConvId = undefined;
    lastValues.latestIsDollars = undefined;
    lastValues.latestIsEst = undefined;
    items.latest.hide();
  }
}

/** Update only the current/latest conversation status bar segment (e.g. when usage.jsonl or active-conversation changes). */
export function updateLatestStatusBarItem(
  item: vscode.StatusBarItem,
  conversations: ConversationUsage[],
  showLatest: boolean,
  activeConversationId?: string
): void {
  if (!showLatest || conversations.length === 0) {
    clearSegmentTimeouts('latest');
    lastValues.latestCost = undefined;
    lastValues.latestConvId = undefined;
    lastValues.latestIsDollars = undefined;
    lastValues.latestIsEst = undefined;
    item.hide();
    return;
  }
  const latest = conversations[0];
  const activeConv = activeConversationId
    ? conversations.find((c) => c.conversationId === activeConversationId)
    : undefined;
  const conv = activeConv ?? latest;
  const deltaCents = conv.deltaCents;
  const estimatedCents = conv.estimatedTokenCents;
  const cents = deltaCents ?? estimatedCents;
  const isDollars = cents != null;
  const isEst = deltaCents == null && estimatedCents != null;
  const displayNum = isDollars ? cents / 100 : conv.turnCount;
  const displayStr = isDollars
    ? `$${displayNum.toFixed(2)}`
    : `${conv.turnCount} turn${conv.turnCount === 1 ? '' : 's'}`;
  const label = activeConv ? 'Current conversation' : 'Latest conversation';
  const tooltipDetail = isDollars
    ? isEst
      ? `Token-based estimate: ${displayStr}`
      : `Cost from Cursor billing: ${displayStr}`
    : `${conv.turnCount} LLM turns (cost unknown until session ends)`;
  item.tooltip = new vscode.MarkdownString(
    `**${label}**\n\n${conv.conversationId.slice(0, 16)}...\n${tooltipDetail} · ${conv.eventCount} events`
  );
  item.command = 'cursorUsageWizard.refreshStats';

  const config = vscode.workspace.getConfiguration('cursorUsageWizard');
  const animationsOn = config.get<boolean>('usageAnimations', true);
  const latestColor = getDefaultStatusBarForegroundHex();
  const sameConv = lastValues.latestConvId === conv.conversationId;
  const sameMode = lastValues.latestIsDollars === isDollars;

  if (!animationsOn || lastValues.latestCost === undefined || !sameConv || !sameMode) {
    item.text = `$(comment-discussion) ${displayStr}`;
    if (!pulseTimeouts['latest']) item.color = latestColor;
    lastValues.latestCost = displayNum;
    lastValues.latestConvId = conv.conversationId;
    lastValues.latestIsDollars = isDollars;
    lastValues.latestIsEst = isEst;
  } else if (lastValues.latestCost !== displayNum) {
    if (!pulseTimeouts['latest']) startPulse(item, 'latest', latestColor);
    const formatter = isDollars
      ? (n: number) => `$${n.toFixed(2)}`
      : (n: number) => `${Math.round(n)} turn${Math.round(n) === 1 ? '' : 's'}`;
    runTween('latest', lastValues.latestCost, displayNum, TWEEN_DURATION_MS, formatter, (formatted) => {
      item.text = `$(comment-discussion) ${formatted}`;
    }, () => {
      lastValues.latestCost = displayNum;
      lastValues.latestConvId = conv.conversationId;
      lastValues.latestIsDollars = isDollars;
      lastValues.latestIsEst = isEst;
    });
  }
  item.show();
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
    lines.push('', '**Per-conversation**');
    for (const c of conversations.slice(0, 5)) {
      const short = c.conversationId.slice(0, 8);
      const costPart =
        c.deltaCents != null
          ? `$${(c.deltaCents / 100).toFixed(2)} (from Cursor)`
          : c.estimatedTokenCents != null
            ? `~$${(c.estimatedTokenCents / 100).toFixed(2)}`
            : `${c.turnCount} turns`;
      lines.push(`- ${short}... ${c.eventCount} events, ${costPart}`);
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
