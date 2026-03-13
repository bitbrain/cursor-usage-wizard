import * as vscode from 'vscode';

const TOKEN_KEY = 'cursorUsageWizard.sessionToken';

export async function getSessionToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  try {
    return await context.secrets.get(TOKEN_KEY);
  } catch {
    return undefined;
  }
}

export async function setSessionToken(
  context: vscode.ExtensionContext,
  token: string
): Promise<void> {
  await context.secrets.store(TOKEN_KEY, token.trim());
}

export async function clearSessionToken(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(TOKEN_KEY);
}
