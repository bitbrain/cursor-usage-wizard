import * as vscode from 'vscode';
import type { NewUsageResponse } from '../services/api';
import type { ConversationUsage } from '../services/usageStore';
import {
  CARBON_INTENSITY_G_PER_KWH,
  DATACENTER_WUE_L_PER_KWH,
} from '../utils/pricing';

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
  waterMl?: number;
  co2g?: number;
  /** True when latest segment shows real $ (deltaCents); false when showing turn count. */
  latestIsDollars?: boolean;
  /** True when showing token estimate instead of Cursor billing. */
  latestIsEst?: boolean;
} = {};
const tweenTimeouts: Record<string, NodeJS.Timeout[]> = Object.create(null);
/** Segments currently visible; only call .show() when not in set to avoid redraw flicker. */
const visibleSegments = new Set<string>();
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

/** Single code path for animating + rendering all 5 usage segments. Caller supplies icon, initial value string, and a runner that performs the tween and calls onStep(formatted) / onDone(). */
function updateSegment(
  segmentKey: string,
  item: vscode.StatusBarItem,
  icon: string,
  newColor: vscode.ThemeColor | string | undefined,
  options: {
    animationsOn: boolean;
    isFirstRun: boolean;
    valueChanged: boolean;
    initialFormatted: string;
    runAnimation: (onStep: (formatted: string) => void, onDone: () => void) => void;
    saveValues: () => void;
  }
): void {
  const { animationsOn, isFirstRun, valueChanged, initialFormatted, runAnimation, saveValues } = options;
  if (!animationsOn || isFirstRun) {
    item.text = `${icon} ${initialFormatted}`;
    item.color = newColor;
    saveValues();
  } else if (valueChanged) {
    startPulse(item, segmentKey, newColor);
    runAnimation(
      (formatted) => {
        item.text = `${icon} ${formatted}`;
      },
      () => {
        saveValues();
      }
    );
  }
}

export function createStatusBarItem(): vscode.StatusBarItem {
  return vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
}

// Priorities 0–4 so this extension's items stay grouped and appear last (rightmost) in the status bar; water/co2 use -1/-2.
const SB_PRIORITY_GROUP = { total: 4, auto: 3, api: 2, onDemand: 1, latest: 0, water: -1, co2: -2 };

/** Seven items: total %, auto %, API pool, on-demand, latest conversation, water, CO2 (each with its own hover). */
export function createUsageStatusBarItems(): {
  total: vscode.StatusBarItem;
  auto: vscode.StatusBarItem;
  api: vscode.StatusBarItem;
  onDemand: vscode.StatusBarItem;
  latest: vscode.StatusBarItem;
  water: vscode.StatusBarItem;
  co2: vscode.StatusBarItem;
} {
  return {
    total: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_PRIORITY_GROUP.total),
    auto: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_PRIORITY_GROUP.auto),
    api: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_PRIORITY_GROUP.api),
    onDemand: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_PRIORITY_GROUP.onDemand),
    latest: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_PRIORITY_GROUP.latest),
    water: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_PRIORITY_GROUP.water),
    co2: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, SB_PRIORITY_GROUP.co2),
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
  water: vscode.StatusBarItem;
  co2: vscode.StatusBarItem;
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
  if (!visibleSegments.has('total')) items.total.show();
  visibleSegments.add('total');
  items.auto.hide();
  items.api.hide();
  items.onDemand.hide();
  items.latest.hide();
  items.water.hide();
  items.co2.hide();
  visibleSegments.delete('auto');
  visibleSegments.delete('api');
  visibleSegments.delete('onDemand');
  visibleSegments.delete('latest');
  visibleSegments.delete('water');
  visibleSegments.delete('co2');
}

function resolveLatestConversation(
  conversations: ConversationUsage[],
  activeConversationId?: string
): { conv: ConversationUsage; label: 'Current conversation' | 'Latest conversation' } {
  const latest = conversations[0];
  const activeConv = activeConversationId
    ? conversations.find((c) => c.conversationId === activeConversationId)
    : undefined;
  return {
    conv: activeConv ?? latest,
    label: activeConv ? 'Current conversation' : 'Latest conversation',
  };
}

function getLatestDisplayData(conv: ConversationUsage): {
  isDollars: boolean;
  isEst: boolean;
  hasCostSignal: boolean;
  displayNum: number;
  displayStr: string;
  tooltipDetail: string;
  formatter: (n: number) => string;
} {
  const deltaCents = conv.deltaCents;
  const estimatedCents = conv.estimatedTokenCents;
  const rawCents = deltaCents ?? estimatedCents;
  const hasCostSignal = rawCents != null;
  // Never show "0 turns"; when there is no cost signal and no turns yet, show "$0.00".
  const cents = rawCents == null && conv.turnCount <= 0 ? 0 : rawCents;
  const isDollars = cents != null;
  const isEst = deltaCents == null && estimatedCents != null;
  const displayNum = isDollars ? cents / 100 : conv.turnCount;
  const displayStr = isDollars
    ? `$${displayNum.toFixed(2)}`
    : `${conv.turnCount} turn${conv.turnCount === 1 ? '' : 's'}`;
  const tooltipDetail = isDollars
    ? isEst
      ? `Token-based estimate: ${displayStr}`
      : `Cost from Cursor billing: ${displayStr}`
    : `${conv.turnCount} LLM turns (cost unknown until session ends)`;
  const formatter = isDollars
    ? (n: number) => `$${n.toFixed(2)}`
    : (n: number) => `${Math.round(n)} turn${Math.round(n) === 1 ? '' : 's'}`;
  return { isDollars, isEst, hasCostSignal, displayNum, displayStr, tooltipDetail, formatter };
}

function formatWaterMl(waterMl: number): string {
  if (waterMl >= 1000) return `${(waterMl / 1000).toFixed(2)}L`;
  if (waterMl >= 100) return `${waterMl.toFixed(0)}mL`;
  if (waterMl >= 10) return `${waterMl.toFixed(1)}mL`;
  return `${waterMl.toFixed(2)}mL`;
}

function formatCo2g(co2g: number): string {
  if (co2g >= 1000) return `${(co2g / 1000).toFixed(2)}kg`;
  if (co2g >= 10) return `${co2g.toFixed(1)}g`;
  if (co2g >= 1) return `${co2g.toFixed(2)}g`;
  return `${co2g.toFixed(3)}g`;
}

function renderWaterAndCo2(
  waterItem: vscode.StatusBarItem,
  co2Item: vscode.StatusBarItem,
  energyWhInput: number | undefined,
  animationsOn: boolean,
  keepPreviousIfMissing: boolean
): void {
  const previousWaterMl = lastValues.waterMl ?? 0;
  const previousCo2g = lastValues.co2g ?? 0;
  const rawEnergyWh = energyWhInput;
  const computedWaterMl =
    rawEnergyWh != null ? rawEnergyWh * DATACENTER_WUE_L_PER_KWH : undefined;
  const computedCo2g =
    rawEnergyWh != null ? (rawEnergyWh / 1000) * CARBON_INTENSITY_G_PER_KWH : undefined;
  const waterMl =
    computedWaterMl == null
      ? (keepPreviousIfMissing ? previousWaterMl : 0)
      : (keepPreviousIfMissing ? Math.max(previousWaterMl, computedWaterMl) : computedWaterMl);
  const co2g =
    computedCo2g == null
      ? (keepPreviousIfMissing ? previousCo2g : 0)
      : (keepPreviousIfMissing ? Math.max(previousCo2g, computedCo2g) : computedCo2g);
  const waterStr = formatWaterMl(waterMl);
  const co2Str = formatCo2g(co2g);
  waterItem.tooltip = new vscode.MarkdownString(
    rawEnergyWh != null
      ? `**Water consumption**\n\n${waterStr} estimated for current conversation\n\nBased on ${rawEnergyWh.toFixed(3)} Wh · WUE ${DATACENTER_WUE_L_PER_KWH} L/kWh`
      : `**Water consumption**\n\n${waterStr} estimated for current conversation\n\nNo fresh token/energy sample in this update; keeping previous value.`
  );
  waterItem.command = 'cursorUsageWizard.refreshStats';
  co2Item.tooltip = new vscode.MarkdownString(
    rawEnergyWh != null
      ? `**CO₂ emissions**\n\n${co2Str} estimated for current conversation\n\nBased on ${rawEnergyWh.toFixed(3)} Wh · ${CARBON_INTENSITY_G_PER_KWH} gCO₂/kWh`
      : `**CO₂ emissions**\n\n${co2Str} estimated for current conversation\n\nNo fresh token/energy sample in this update; keeping previous value.`
  );
  co2Item.command = 'cursorUsageWizard.refreshStats';
  updateSegment('water', waterItem, '$(beaker)', undefined, {
    animationsOn,
    isFirstRun: lastValues.waterMl === undefined,
    valueChanged: lastValues.waterMl !== waterMl,
    initialFormatted: waterStr,
    runAnimation: (onStep, onDone) => {
      runTween('water', lastValues.waterMl!, waterMl, TWEEN_DURATION_MS, formatWaterMl, onStep, onDone);
    },
    saveValues: () => {
      lastValues.waterMl = waterMl;
    },
  });
  updateSegment('co2', co2Item, '$(flame)', undefined, {
    animationsOn,
    isFirstRun: lastValues.co2g === undefined,
    valueChanged: lastValues.co2g !== co2g,
    initialFormatted: `${co2Str} CO₂`,
    runAnimation: (onStep, onDone) => {
      runTween('co2', lastValues.co2g!, co2g, TWEEN_DURATION_MS, (n) => `${formatCo2g(n)} CO₂`, onStep, onDone);
    },
    saveValues: () => {
      lastValues.co2g = co2g;
    },
  });
  if (!visibleSegments.has('water')) waterItem.show();
  if (!visibleSegments.has('co2')) co2Item.show();
  visibleSegments.add('water');
  visibleSegments.add('co2');
}

function renderLatestConversationSegment(
  latestItem: vscode.StatusBarItem,
  waterItem: vscode.StatusBarItem,
  co2Item: vscode.StatusBarItem,
  conv: ConversationUsage,
  label: 'Current conversation' | 'Latest conversation',
  animationsOn: boolean
): void {
  const sameConv = lastValues.latestConvId === conv.conversationId;
  const rawDisplay = getLatestDisplayData(conv);
  const display = { ...rawDisplay };
  if (
    sameConv &&
    !rawDisplay.hasCostSignal &&
    conv.turnCount <= 0 &&
    lastValues.latestCost !== undefined &&
    lastValues.latestIsDollars === true
  ) {
    display.displayNum = lastValues.latestCost;
    display.displayStr = `$${display.displayNum.toFixed(2)}`;
    display.tooltipDetail = `Cost from Cursor billing: ${display.displayStr}`;
    display.isDollars = true;
    display.isEst = false;
    display.formatter = (n: number) => `$${n.toFixed(2)}`;
  } else if (
    sameConv &&
    rawDisplay.isDollars &&
    lastValues.latestIsDollars === true &&
    lastValues.latestCost !== undefined
  ) {
    display.displayNum = Math.max(lastValues.latestCost, rawDisplay.displayNum);
    display.displayStr = `$${display.displayNum.toFixed(2)}`;
    display.tooltipDetail = rawDisplay.isEst
      ? `Token-based estimate: ${display.displayStr}`
      : `Cost from Cursor billing: ${display.displayStr}`;
  }
  latestItem.tooltip = new vscode.MarkdownString(
    `**${label}**\n\n${conv.conversationId.slice(0, 16)}...\n${display.tooltipDetail} · ${conv.eventCount} events`
  );
  latestItem.command = 'cursorUsageWizard.refreshStats';
  const latestColor = undefined;
  const sameMode = lastValues.latestIsDollars === display.isDollars;
  const latestFirstRun = lastValues.latestCost === undefined || !sameConv || !sameMode;
  const latestChanged = lastValues.latestCost !== display.displayNum;
  updateSegment('latest', latestItem, '$(comment-discussion)', latestColor, {
    animationsOn,
    isFirstRun: latestFirstRun,
    valueChanged: latestChanged,
    initialFormatted: display.displayStr,
    runAnimation: (onStep, onDone) => {
      runTween('latest', lastValues.latestCost!, display.displayNum, TWEEN_DURATION_MS, display.formatter, onStep, onDone);
    },
    saveValues: () => {
      lastValues.latestCost = display.displayNum;
      lastValues.latestConvId = conv.conversationId;
      lastValues.latestIsDollars = display.isDollars;
      lastValues.latestIsEst = display.isEst;
    },
  });
  if (!visibleSegments.has('latest')) latestItem.show();
  visibleSegments.add('latest');
  renderWaterAndCo2(waterItem, co2Item, conv.estimatedEnergyWh, animationsOn, sameConv);
}

function renderZeroLatestAndImpact(
  latestItem: vscode.StatusBarItem,
  waterItem: vscode.StatusBarItem,
  co2Item: vscode.StatusBarItem
): void {
  latestItem.text = '$(comment-discussion) $0.00';
  latestItem.tooltip = new vscode.MarkdownString(
    '**Current conversation**\n\nNo conversation data yet.\nCost from Cursor billing: $0.00'
  );
  latestItem.command = 'cursorUsageWizard.refreshStats';
  waterItem.text = '$(beaker) 0.00mL';
  waterItem.tooltip = new vscode.MarkdownString(
    '**Water consumption**\n\n0.00mL estimated for current conversation'
  );
  waterItem.command = 'cursorUsageWizard.refreshStats';
  co2Item.text = '$(flame) 0.000g CO₂';
  co2Item.tooltip = new vscode.MarkdownString(
    '**CO₂ emissions**\n\n0.000g estimated for current conversation'
  );
  co2Item.command = 'cursorUsageWizard.refreshStats';
  lastValues.latestCost = 0;
  lastValues.latestConvId = undefined;
  lastValues.latestIsDollars = true;
  lastValues.latestIsEst = false;
  lastValues.waterMl = 0;
  lastValues.co2g = 0;
  if (!visibleSegments.has('latest')) latestItem.show();
  if (!visibleSegments.has('water')) waterItem.show();
  if (!visibleSegments.has('co2')) co2Item.show();
  visibleSegments.add('latest');
  visibleSegments.add('water');
  visibleSegments.add('co2');
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
  // Do not clear all animation timeouts here — it restores pulse colors and can cause flicker.
  // Clear only when switching to no-usage state; each segment clears its own timeouts when animating.

  const pct = usage.totalPercent ?? usage.apiPool.percent;
  const pctStr = fmtPct(pct);
  const totalColor = getStatusBarColor(pct);

  items.total.tooltip = buildFullTooltip(usage, conversations, showPerConversation);
  items.total.command = 'cursorUsageWizard.refreshStats';
  updateSegment('total', items.total, '$(graph)', totalColor, {
    animationsOn,
    isFirstRun: lastValues.totalPct === undefined,
    valueChanged: lastValues.totalPct !== pct,
    initialFormatted: pctStr,
    runAnimation: (onStep, onDone) => {
      runTween('total', lastValues.totalPct!, pct, TWEEN_DURATION_MS, fmtPct, onStep, onDone);
    },
    saveValues: () => {
      lastValues.totalPct = pct;
    },
  });
  if (!visibleSegments.has('total')) items.total.show();
  visibleSegments.add('total');

  // Auto (included) % — Auto + Composer usage, only when present
  if (usage.autoComposerPool != null) {
    const autoPct = usage.autoComposerPool.percent;
    const autoPctStr = fmtPct(autoPct);
    const autoColor = getStatusBarColor(autoPct);
    items.auto.tooltip = buildAutoTooltip(autoPct);
    items.auto.command = 'cursorUsageWizard.refreshStats';
    updateSegment('auto', items.auto, '$(sparkle)', autoColor, {
      animationsOn,
      isFirstRun: lastValues.autoPct === undefined,
      valueChanged: lastValues.autoPct !== autoPct,
      initialFormatted: autoPctStr,
      runAnimation: (onStep, onDone) => {
        runTween('auto', lastValues.autoPct!, autoPct, TWEEN_DURATION_MS, fmtPct, onStep, onDone);
      },
      saveValues: () => {
        lastValues.autoPct = autoPct;
      },
    });
    if (!visibleSegments.has('auto')) items.auto.show();
    visibleSegments.add('auto');
  } else {
    lastValues.autoPct = undefined;
    items.auto.hide();
    visibleSegments.delete('auto');
  }

  // API pool — icon + $ used/limit
  const apiUsed = usage.apiPool.usedCents;
  const apiLimit = usage.apiPool.limitCents;
  const apiStr = `${fmtDollars(apiUsed)}/${fmtDollars(apiLimit)}`;
  const apiColor = getStatusBarColor(usage.apiPool.percent);
  items.api.tooltip = buildApiTooltip(usage);
  items.api.command = 'cursorUsageWizard.refreshStats';
  const apiFirstRun = lastValues.apiUsedCents === undefined;
  const apiChanged = lastValues.apiUsedCents !== apiUsed || lastValues.apiLimitCents !== apiLimit;
  const startUsed = lastValues.apiUsedCents ?? apiUsed;
  const startLimit = lastValues.apiLimitCents ?? apiLimit;
  updateSegment('api', items.api, '$(circuit-board)', apiColor, {
    animationsOn,
    isFirstRun: apiFirstRun,
    valueChanged: apiChanged,
    initialFormatted: apiStr,
    runAnimation: (onStep, onDone) => {
      runTweenCustom('api', TWEEN_DURATION_MS, (t) => {
        const u = Math.round(startUsed + (apiUsed - startUsed) * t);
        const l = Math.round(startLimit + (apiLimit - startLimit) * t);
        return `${fmtDollars(u)}/${fmtDollars(l)}`;
      }, onStep, onDone);
    },
    saveValues: () => {
      lastValues.apiUsedCents = apiUsed;
      lastValues.apiLimitCents = apiLimit;
    },
  });
  if (!visibleSegments.has('api')) items.api.show();
  visibleSegments.add('api');

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
    const odEndLimit = od.limitCents;
    updateSegment('onDemand', items.onDemand, '$(credit-card)', odColor, {
      animationsOn,
      isFirstRun: lastValues.onDemandUsedCents === undefined,
      valueChanged: lastValues.onDemandUsedCents !== odUsed,
      initialFormatted: odStr,
      runAnimation: (onStep, onDone) => {
        const startUsed = lastValues.onDemandUsedCents!;
        runTween('onDemand', startUsed, odUsed, TWEEN_DURATION_MS, (cents) => {
          const c = Math.round(cents);
          return odEndLimit != null ? `${fmtDollars(c)}/${fmtDollars(odEndLimit)}` : fmtDollars(c);
        }, onStep, onDone);
      },
      saveValues: () => {
        lastValues.onDemandUsedCents = odUsed;
      },
    });
    if (!visibleSegments.has('onDemand')) items.onDemand.show();
    visibleSegments.add('onDemand');
  } else {
    lastValues.onDemandUsedCents = undefined;
    items.onDemand.hide();
    visibleSegments.delete('onDemand');
  }

  // Current/latest conversation + water/CO2
  if (showLatestInStatusBar !== false && conversations && conversations.length > 0) {
    const { conv, label } = resolveLatestConversation(conversations, activeConversationId);
    renderLatestConversationSegment(items.latest, items.water, items.co2, conv, label, animationsOn);
  } else if (showLatestInStatusBar !== false) {
    renderZeroLatestAndImpact(items.latest, items.water, items.co2);
  } else {
    items.latest.hide();
    items.water.hide();
    items.co2.hide();
    visibleSegments.delete('latest');
    visibleSegments.delete('water');
    visibleSegments.delete('co2');
  }
}

/** Update only the current/latest conversation status bar segment (e.g. when usage.jsonl or active-conversation changes). */
export function updateLatestStatusBarItem(
  item: vscode.StatusBarItem,
  waterItem: vscode.StatusBarItem,
  co2Item: vscode.StatusBarItem,
  conversations: ConversationUsage[],
  showLatest: boolean,
  activeConversationId?: string
): void {
  if (!showLatest) {
    item.hide();
    waterItem.hide();
    co2Item.hide();
    visibleSegments.delete('latest');
    visibleSegments.delete('water');
    visibleSegments.delete('co2');
    return;
  }
  if (conversations.length === 0) {
    renderZeroLatestAndImpact(item, waterItem, co2Item);
    return;
  }
  const { conv, label } = resolveLatestConversation(conversations, activeConversationId);
  const config = vscode.workspace.getConfiguration('cursorUsageWizard');
  const animationsOn = config.get<boolean>('usageAnimations', true);
  renderLatestConversationSegment(item, waterItem, co2Item, conv, label, animationsOn);
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
