import * as vscode from 'vscode';

let channel: vscode.OutputChannel | null = null;

export function initLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Cursor Usage Wizard');
  }
  return channel;
}

export function getLogger(): vscode.OutputChannel | null {
  return channel;
}

export function log(msg: string): void {
  const ts = new Date().toISOString();
  channel?.appendLine(`[${ts}] ${msg}`);
}

export function logResponse(
  path: string,
  useRsc: boolean,
  status: number,
  contentType: string,
  bodyLength: number,
  bodyPreview?: string
): void {
  log(`GET /dashboard/${path}${useRsc ? '?_rsc=1' : ''} → ${status} ${contentType || '(no ct)'} body=${bodyLength} bytes`);
  if (bodyPreview !== undefined) {
    const preview = bodyPreview.length > 400 ? bodyPreview.slice(0, 400) + '…' : bodyPreview;
    log(`  body preview: ${preview.replace(/\n/g, ' ')}`);
  }
}

export function logTokenSanitization(
  rawLength: number,
  sanitizedLength: number,
  removedCharCodes: number[]
): void {
  log(`token: raw length=${rawLength}, sanitized length=${sanitizedLength}`);
  if (removedCharCodes.length > 0) {
    log(`  removed character codes: ${[...new Set(removedCharCodes)].sort((a, b) => a - b).join(', ')}`);
  }
}
