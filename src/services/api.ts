import axios from 'axios';
import { log, logResponse, logTokenSanitization } from '../utils/logger';

const BASE = 'https://cursor.com';

function sanitizeToken(token: string): { value: string; removedCharCodes: number[] } {
  const removedCharCodes: number[] = [];
  if (typeof token !== 'string') return { value: '', removedCharCodes: [] };
  let value = '';
  for (let i = 0; i < token.length; i++) {
    const code = token.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code > 0x7e || code === 0x22 || code === 0x5c) {
      removedCharCodes.push(code);
    } else {
      value += token[i];
    }
  }
  value = value.trim();
  return { value, removedCharCodes };
}

function getDashboardHeaders(cookieValue: string, acceptJson = true): Record<string, string> {
  const h: Record<string, string> = {
    Cookie: `WorkosCursorSessionToken=${cookieValue}`,
    Origin: BASE,
    Referer: `${BASE}/dashboard`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  if (acceptJson) {
    h['Accept'] = 'application/json';
  }
  return h;
}

function getPostHeaders(cookieValue: string): Record<string, string> {
  const h = getDashboardHeaders(cookieValue, true);
  h['Content-Type'] = 'application/json';
  return h;
}

// --- New plan model (Pro / Pro+ / Ultra) ---

export const PLAN_API_LIMITS_CENTS = {
  free: 0,
  pro: 2000,
  pro_plus: 7000,
  ultra: 40000,
} as const;

export type PlanTier = keyof typeof PLAN_API_LIMITS_CENTS;

export interface NewUsageResponse {
  plan: PlanTier;
  apiPool: { usedCents: number; limitCents: number; percent: number };
  autoComposerPool?: { percent: number };
  totalPercent?: number;
  onDemand?: { usedCents: number; limitCents: number | null };
  resetDate?: string;
}

// Next.js RSC route state (must match dashboard layout)
const RSC_STATE_USAGE = encodeURIComponent(
  '["",{"children":[["locale","en-US","d"],{"children":["dashboard",{"children":[["tab","usage","d"],{"children":["__PAGE__",{},null,null]},null,null]},null,null]},null,null,true]},null,null]'
);
const RSC_STATE_SPENDING = encodeURIComponent(
  '["",{"children":[["locale","en-US","d"],{"children":["dashboard",{"children":[["tab","spending","d"],{"children":["__PAGE__",{},null,null]},null,null]},null,null]},null,null,true]},null,null]'
);

function getRscHeaders(cookieValue: string, path: 'usage' | 'spending'): Record<string, string> {
  const nextUrl = `/en-US/dashboard/${path}`;
  const stateTree = path === 'usage' ? RSC_STATE_USAGE : RSC_STATE_SPENDING;
  return {
    Cookie: `WorkosCursorSessionToken=${cookieValue}`,
    Origin: BASE,
    Referer: `${BASE}/dashboard`,
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    rsc: '1',
    'next-router-state-tree': stateTree,
    'next-router-prefetch': '1',
    'next-url': nextUrl,
  };
}

// Try non-RSC GET first; if that fails or returns HTML, try with RSC headers
async function fetchDashboardRaw(
  token: string,
  path: 'usage' | 'spending'
): Promise<{ data: string; contentType: string } | undefined> {
  const { value: cookieValue, removedCharCodes } = sanitizeToken(token);
  logTokenSanitization(token.length, cookieValue.length, removedCharCodes);
  if (!cookieValue) {
    log('fetchDashboardRaw: cookie value empty after sanitization');
    return undefined;
  }

  const tryFetch = async (headers: Record<string, string>, useRsc = false) => {
    const url = `${BASE}/dashboard/${path}${useRsc ? '?_rsc=1' : ''}`;
    try {
      const response = await axios.get(url, {
        headers,
        responseType: 'text',
        validateStatus: () => true,
        maxRedirects: 0,
        timeout: 15000,
      });
      const contentType = (response.headers['content-type'] || '').toLowerCase();
      const body = typeof response.data === 'string' ? response.data : '';
      const location = response.headers['location'];
      logResponse(path, useRsc, response.status, contentType, body.length, body.slice(0, 300));
      if (response.status !== 200) {
        if (location) log(`  redirect location: ${location}`);
        return undefined;
      }
      return { data: body, contentType };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  error: ${msg}`);
      return undefined;
    }
  };

  try {
    log(`fetchDashboardRaw(${path}): trying without RSC`);
    let result = await tryFetch(getDashboardHeaders(cookieValue), false);
    if (result) {
      if (result.contentType.includes('application/json')) {
        log(`  using response as application/json`);
        return result;
      }
      if (result.contentType.includes('text/html')) {
        log(`  using response (text/html, ${result.data.length} bytes)`);
        return result;
      }
      log(`  first response not usable (ct=${result.contentType}), trying RSC`);
    } else {
      log(`  first request failed or non-200, trying RSC`);
    }
    result = await tryFetch(getRscHeaders(cookieValue, path), true);
    if (result) log(`  using RSC response`);
    return result ?? undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`fetchDashboardRaw(${path}) error: ${msg}`);
    return undefined;
  }
}

// Heuristic: extract usage from RSC Flight payload (line-prefixed JSON and/or raw text)
function extractUsageFromRscPayload(body: string): Partial<NewUsageResponse> | undefined {
  const out: Partial<NewUsageResponse> = {};
  let text = body;
  const lineMatch = body.match(/^\d+:(.+)/m);
  if (lineMatch) {
    text = lineMatch[1];
    try {
      const obj = JSON.parse(lineMatch[1]) as Record<string, unknown>;
      text = JSON.stringify(obj);
      const walk = (o: unknown): void => {
        if (!o || typeof o !== 'object') return;
        for (const v of Object.values(o)) {
          if (v && typeof v === 'object' && 'usedCents' in v) {
            const u = (v as Record<string, unknown>).usedCents;
            const l = (v as Record<string, unknown>).limitCents;
            const p = (v as Record<string, unknown>).percent;
            if (typeof u === 'number') out.apiPool = { usedCents: u, limitCents: typeof l === 'number' ? l : 0, percent: typeof p === 'number' ? p : 0 };
          }
          walk(v);
        }
      };
      walk(obj);
    } catch {
      // ignore
    }
  }
  if (!out.apiPool) {
    const usedCentsMatch = text.match(/"usedCents"\s*:\s*(\d+)/);
    const limitCentsMatch = text.match(/"limitCents"\s*:\s*(\d+)/);
    const percentMatch = text.match(/"percent"\s*:\s*(\d+(?:\.\d+)?)/);
    if (usedCentsMatch) out.apiPool = { usedCents: parseInt(usedCentsMatch[1], 10), limitCents: 0, percent: 0 };
    if (limitCentsMatch && out.apiPool) out.apiPool.limitCents = parseInt(limitCentsMatch[1], 10);
    if (percentMatch) {
      const pct = parseFloat(percentMatch[1]);
      if (out.apiPool) out.apiPool.percent = pct;
      else out.totalPercent = pct;
    }
  }
  if (out.apiPool && out.apiPool.limitCents === 0 && out.apiPool.usedCents > 0) {
    out.apiPool.limitCents = PLAN_API_LIMITS_CENTS.ultra;
  }
  return Object.keys(out).length ? out : undefined;
}

function extractSpendingFromRscPayload(body: string): NewUsageResponse['onDemand'] | undefined {
  const usedMatch = body.match(/"onDemandUsedCents"\s*:\s*(\d+)/) ?? body.match(/"usedCents"\s*:\s*(\d+)/);
  const limitMatch = body.match(/"onDemandLimitCents"\s*:\s*(\d+)/) ?? body.match(/"limitCents"\s*:\s*(\d+)/);
  if (!usedMatch) return undefined;
  const usedCents = parseInt(usedMatch[1], 10);
  const limitCents = limitMatch ? parseInt(limitMatch[1], 10) : null;
  return { usedCents, limitCents };
}

function deepFindUsageInJson(obj: unknown): NewUsageResponse | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.usedCents === 'number') {
    const usedCents = rec.usedCents;
    const limitCents = typeof rec.limitCents === 'number' ? rec.limitCents : PLAN_API_LIMITS_CENTS.ultra;
    const percent = typeof rec.percent === 'number' ? rec.percent : (limitCents ? Math.round(usedCents / limitCents * 100) : 0);
    return normalizeNewUsage({
      plan: (rec.plan as PlanTier) ?? 'ultra',
      apiPool: { usedCents, limitCents, percent },
      autoComposerPool: typeof rec.autoComposerPercent === 'number' ? { percent: rec.autoComposerPercent } : undefined,
      totalPercent: typeof rec.totalPercent === 'number' ? rec.totalPercent : undefined,
      onDemand: typeof rec.onDemandUsedCents === 'number'
        ? { usedCents: rec.onDemandUsedCents, limitCents: typeof rec.onDemandLimitCents === 'number' ? rec.onDemandLimitCents : null }
        : undefined,
    });
  }
  for (const v of Object.values(rec)) {
    const found = deepFindUsageInJson(v);
    if (found) return found;
  }
  return undefined;
}

function extractUsageFromRawHtml(html: string): Partial<NewUsageResponse> | undefined {
  const usedCentsMatch = html.match(/"usedCents"\s*:\s*(\d+)/);
  if (!usedCentsMatch) return undefined;
  const usedCents = parseInt(usedCentsMatch[1], 10);
  const limitCentsMatch = html.match(/"limitCents"\s*:\s*(\d+)/);
  const limitCents = limitCentsMatch ? parseInt(limitCentsMatch[1], 10) : PLAN_API_LIMITS_CENTS.ultra;
  const percentMatch = html.match(/"percent"\s*:\s*(\d+(?:\.\d+)?)/);
  const percent = percentMatch ? parseFloat(percentMatch[1]) : (limitCents ? Math.round(usedCents / limitCents * 100) : 0);
  return {
    plan: 'ultra',
    apiPool: { usedCents, limitCents, percent },
  };
}

function extractSpendingFromRawHtml(html: string): NewUsageResponse['onDemand'] | undefined {
  const usedMatch = html.match(/"onDemandUsedCents"\s*:\s*(\d+)/) ?? html.match(/"usedCents"\s*:\s*(\d+)/);
  if (!usedMatch) return undefined;
  const usedCents = parseInt(usedMatch[1], 10);
  const limitMatch = html.match(/"onDemandLimitCents"\s*:\s*(\d+)/) ?? html.match(/"limitCents"\s*:\s*(\d+)/);
  const limitCents = limitMatch ? parseInt(limitMatch[1], 10) : null;
  return { usedCents, limitCents };
}

function buildNewUsageFromJson(json: Record<string, unknown>): NewUsageResponse | undefined {
  const apiPool = (json.apiPool ?? json.api ?? json) as Record<string, unknown> | undefined;
  const usedCents = (apiPool?.usedCents ?? json.usedCents) as number | undefined;
  const limitCents = (apiPool?.limitCents ?? json.limitCents) as number | undefined;
  const percent = (apiPool?.percent ?? json.percent) as number | undefined;
  if (typeof usedCents !== 'number') return undefined;
  return normalizeNewUsage({
    plan: (json.plan as PlanTier) ?? 'ultra',
    apiPool: {
      usedCents,
      limitCents: limitCents ?? PLAN_API_LIMITS_CENTS.ultra,
      percent: percent ?? 0,
    },
    autoComposerPool: json.autoComposerPool as { percent: number } | undefined,
    totalPercent: json.totalPercent as number | undefined,
    onDemand: json.onDemand as NewUsageResponse['onDemand'],
    resetDate: json.resetDate as string | undefined,
  });
}

function normalizeNewUsage(usage: Partial<NewUsageResponse>, spending?: NewUsageResponse['onDemand']): NewUsageResponse | undefined {
  if (!usage.apiPool) return undefined;
  const plan = usage.plan ?? 'ultra';
  const limitCents = usage.apiPool.limitCents || PLAN_API_LIMITS_CENTS[plan] || PLAN_API_LIMITS_CENTS.ultra;
  const apiPool = {
    usedCents: usage.apiPool.usedCents ?? 0,
    limitCents,
    percent: usage.apiPool.percent ?? (limitCents ? Math.round((usage.apiPool.usedCents ?? 0) / limitCents * 100) : 0),
  };
  return {
    plan,
    apiPool,
    autoComposerPool: usage.autoComposerPool,
    totalPercent: usage.totalPercent,
    onDemand: spending ?? usage.onDemand,
    resetDate: usage.resetDate,
  };
}

export interface FetchUsageResult {
  usage?: NewUsageResponse;
  /** True if the request succeeded (e.g. 200); false if network/auth failed. */
  authOk: boolean;
}

// Dashboard POST APIs (discovered from browser network trace)
const API_GET_CURRENT_PERIOD_USAGE = `${BASE}/api/dashboard/get-current-period-usage`;
const API_GET_PLAN_INFO = `${BASE}/api/dashboard/get-plan-info`;

async function postDashboardApi(
  cookieValue: string,
  url: string,
  body: object = {}
): Promise<unknown | undefined> {
  try {
    const response = await axios.post(url, body, {
      headers: getPostHeaders(cookieValue),
      responseType: 'json',
      validateStatus: () => true,
      timeout: 15000,
    });
    if (response.status !== 200) {
      log(`postDashboardApi ${url} → ${response.status}`);
      return undefined;
    }
    return response.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`postDashboardApi ${url} error: ${msg}`);
    return undefined;
  }
}

function buildUsageFromDashboardApis(
  usagePayload: unknown,
  planPayload: unknown
): NewUsageResponse | undefined {
  const u = usagePayload as Record<string, unknown> | undefined;
  const p = planPayload as Record<string, unknown> | undefined;
  if (!u) return undefined;

  const planUsage = u.planUsage as Record<string, unknown> | undefined;
  const spendLimit = u.spendLimitUsage as Record<string, unknown> | undefined;
  if (!planUsage || typeof planUsage.includedSpend !== 'number') return undefined;

  const includedSpend = planUsage.includedSpend as number;
  const limit = (typeof planUsage.limit === 'number' ? planUsage.limit : PLAN_API_LIMITS_CENTS.ultra) as number;
  const apiPercentUsed = typeof planUsage.apiPercentUsed === 'number' ? planUsage.apiPercentUsed : (limit ? Math.round((includedSpend / limit) * 100) : 0);
  const autoPercentUsed = typeof planUsage.autoPercentUsed === 'number' ? planUsage.autoPercentUsed : undefined;
  const totalPercentUsed = typeof planUsage.totalPercentUsed === 'number' ? planUsage.totalPercentUsed : apiPercentUsed;

  const planInfo = p?.planInfo as Record<string, unknown> | undefined;
  const planName = (planInfo?.plan ?? planInfo?.name ?? planInfo?.tier ?? 'ultra') as string;
  const plan = (planName === 'pro_plus' || planName === 'pro+' ? 'pro_plus' : planName === 'pro' ? 'pro' : planName === 'free' ? 'free' : 'ultra') as PlanTier;

  let onDemand: { usedCents: number; limitCents: number | null } | undefined;
  if (spendLimit && typeof spendLimit.individualUsed === 'number') {
    const individualUsed = spendLimit.individualUsed as number;
    const individualLimit = typeof spendLimit.individualLimit === 'number' ? (spendLimit.individualLimit as number) : null;
    onDemand = { usedCents: individualUsed, limitCents: individualLimit };
  }

  let resetDate: string | undefined;
  const cycleEnd = u.billingCycleEnd;
  if (typeof cycleEnd === 'string' && /^\d+$/.test(cycleEnd)) {
    const ms = parseInt(cycleEnd, 10);
    resetDate = new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  return {
    plan,
    apiPool: { usedCents: includedSpend, limitCents: limit, percent: apiPercentUsed },
    autoComposerPool: autoPercentUsed !== undefined ? { percent: autoPercentUsed } : undefined,
    totalPercent: totalPercentUsed,
    onDemand,
    resetDate,
  };
}

export async function fetchNewUsage(token: string): Promise<FetchUsageResult> {
  log('fetchNewUsage: start');
  const { value: cookieValue, removedCharCodes } = sanitizeToken(token);
  logTokenSanitization(token.length, cookieValue.length, removedCharCodes);
  if (!cookieValue) {
    log('fetchNewUsage: empty token after sanitization');
    return { authOk: false };
  }

  const usagePayload = await postDashboardApi(cookieValue, API_GET_CURRENT_PERIOD_USAGE);
  const planPayload = await postDashboardApi(cookieValue, API_GET_PLAN_INFO);
  if (usagePayload !== undefined) {
    const keys = Object.keys(usagePayload as object);
    log(`fetchNewUsage: get-current-period-usage response keys: ${keys.join(', ')}`);
    log(`fetchNewUsage: get-current-period-usage sample: ${JSON.stringify(usagePayload).slice(0, 500)}`);
    if (planPayload !== undefined) {
      log(`fetchNewUsage: get-plan-info response keys: ${Object.keys(planPayload as object).join(', ')}`);
    }
    const built = buildUsageFromDashboardApis(usagePayload, planPayload);
    if (built) {
      log('fetchNewUsage: parsed from dashboard POST APIs');
      return { authOk: true, usage: built };
    }
  }

  const raw = await fetchDashboardRaw(token, 'usage');
  if (!raw) {
    log('fetchNewUsage: no response from usage');
    return { authOk: false };
  }

  const { data, contentType } = raw;
  log(`fetchNewUsage: got ${contentType} ${data.length} bytes (HTML fallback)`);

  if (contentType.includes('application/json')) {
    try {
      const json = JSON.parse(data);
      const built = buildNewUsageFromJson(json);
      if (built) {
        log('fetchNewUsage: parsed from application/json');
        return { authOk: true, usage: built };
      }
      log('fetchNewUsage: buildNewUsageFromJson returned undefined');
    } catch (e) {
      log(`fetchNewUsage: JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (contentType.includes('text/html')) {
    const nextDataMatch = data.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (nextDataMatch) {
      try {
        const json = JSON.parse(nextDataMatch[1]) as Record<string, unknown>;
        const pageProps = json.props as Record<string, unknown> | undefined;
        const candidate = (pageProps?.pageProps ?? pageProps ?? json) as Record<string, unknown>;
        let built = buildNewUsageFromJson(candidate);
        if (built) {
          log('fetchNewUsage: parsed from __NEXT_DATA__ pageProps');
          return { authOk: true, usage: built };
        }
        built = deepFindUsageInJson(json);
        if (built) {
          log('fetchNewUsage: parsed from __NEXT_DATA__ (deep search)');
          return { authOk: true, usage: built };
        }
      } catch (e) {
        log(`fetchNewUsage: __NEXT_DATA__ parse failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      log('fetchNewUsage: no __NEXT_DATA__ script in HTML');
    }
    const partialFromHtml = extractUsageFromRawHtml(data);
    if (partialFromHtml) {
      log(`fetchNewUsage: extracted from HTML regex (usedCents=${partialFromHtml.apiPool?.usedCents})`);
      const spendingRaw = await fetchDashboardRaw(token, 'spending');
      const spending = spendingRaw ? extractSpendingFromRawHtml(spendingRaw.data) ?? extractSpendingFromRscPayload(spendingRaw.data) : undefined;
      const out = normalizeNewUsage(partialFromHtml, spending);
      if (out) return { authOk: true, usage: out };
    }
  }

  const partial = extractUsageFromRscPayload(data);
  if (!partial) {
    log('fetchNewUsage: extractUsageFromRscPayload returned nothing (no usedCents/percent in body)');
    return { authOk: true };
  }
  log(`fetchNewUsage: RSC heuristic got apiPool.usedCents=${partial.apiPool?.usedCents}`);
  const spendingRaw = await fetchDashboardRaw(token, 'spending');
  const spending = spendingRaw ? extractSpendingFromRscPayload(spendingRaw.data) : undefined;
  const out = normalizeNewUsage(partial, spending);
  if (out) log('fetchNewUsage: returning normalized usage');
  return { authOk: true, usage: out };
}

export async function fetchNewSpending(token: string): Promise<NewUsageResponse['onDemand'] | undefined> {
  const raw = await fetchDashboardRaw(token, 'spending');
  if (!raw) return undefined;
  if (raw.contentType.includes('application/json')) {
    try {
      const json = JSON.parse(raw.data);
      const od = json.onDemand ?? json;
      const usedCents = od.usedCents ?? od.onDemandUsedCents;
      if (typeof usedCents !== 'number') return undefined;
      return { usedCents, limitCents: od.limitCents ?? od.onDemandLimitCents ?? null };
    } catch {
      return undefined;
    }
  }
  return extractSpendingFromRscPayload(raw.data);
}

// --- Legacy (kept for type compatibility; not used when using new plan) ---

export interface UsageData {
  [model: string]: {
    numRequests: number;
    maxRequestUsage: number | null;
    numTokens?: number;
  };
}

export interface CursorUsageResponse {
  current: number;
  limit: number;
  startOfMonth: string;
  usageData?: UsageData;
}
