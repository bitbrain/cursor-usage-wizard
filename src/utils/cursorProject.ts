import * as os from 'os';
import * as path from 'path';

/**
 * Derive Cursor's agent-transcripts directory path for a workspace root.
 * Cursor uses ~/.cursor/projects/<slug>/agent-transcripts where slug is the
 * workspace path with separators replaced by '-'.
 */
export function getAgentTranscriptsPathForWorkspace(workspaceRootPath: string): string {
  const normalized = path.normalize(workspaceRootPath);
  const slug = normalized
    .split(path.sep)
    .filter(Boolean)
    .join('-');
  return path.join(os.homedir(), '.cursor', 'projects', slug, 'agent-transcripts');
}
