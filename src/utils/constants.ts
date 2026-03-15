import * as os from 'os';
import * as path from 'path';

export function getWorkspaceSlug(workspaceRoot: string): string {
  return path.normalize(workspaceRoot).split(path.sep).filter(Boolean).join('-');
}

export function getUsageStorePath(override?: string, workspaceRoot?: string): string {
  if (override && override.trim() !== '') {
    return override.trim();
  }
  const base = path.join(os.homedir(), '.cursor', 'usage-wizard');
  if (workspaceRoot) {
    return path.join(base, getWorkspaceSlug(workspaceRoot));
  }
  return base;
}
