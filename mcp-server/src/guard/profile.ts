import * as fs from 'node:fs';
import * as path from 'node:path';

export const PINNED_PROFILE = 'Default';

export interface ChromeProfile {
  dir: string;
  account: string;
  name: string;
}

export type ProfileVerdict =
  | { outcome: 'pinned'; profiles: ChromeProfile[] }
  | { outcome: 'fresh' }
  | { outcome: 'refused'; reason: 'multiple-profiles'; profiles: ChromeProfile[]; extra: ChromeProfile[]; next: string }
  | { outcome: 'blind'; reason: string };

interface InfoCacheEntry {
  user_name?: unknown;
  name?: unknown;
}

export function verdictOf(localState: unknown, userDataDir: string): ProfileVerdict {
  const cache = (localState as { profile?: { info_cache?: Record<string, InfoCacheEntry> } } | null)?.profile?.info_cache;
  if (!cache || typeof cache !== 'object') return { outcome: 'fresh' };
  const profiles: ChromeProfile[] = Object.entries(cache).map(([dir, e]) => ({
    dir,
    account: typeof e?.user_name === 'string' ? e.user_name : '',
    name: typeof e?.name === 'string' ? e.name : '',
  }));
  if (profiles.length <= 1) return profiles.length === 0 ? { outcome: 'fresh' } : { outcome: 'pinned', profiles };
  const extra = profiles.filter((p) => p.dir !== PINNED_PROFILE);
  return {
    outcome: 'refused',
    reason: 'multiple-profiles',
    profiles,
    extra,
    next:
      `${userDataDir} holds ${profiles.length} Chrome profiles, and the DevTools port serves tabs from whichever profile window was last active. ` +
      `Close the windows of ${extra.map((p) => `'${p.dir}'`).join(', ')} and move them out of that directory (curupira never deletes a profile), ` +
      `or point CURUPIRA_WORKSPACE_CHROME_PROFILE at a directory that holds only '${PINNED_PROFILE}'.`,
  };
}

export function profileVerdict(userDataDir: string): ProfileVerdict {
  const file = path.join(userDataDir, 'Local State');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { outcome: 'fresh' };
    return { outcome: 'blind', reason: `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return verdictOf(JSON.parse(raw), userDataDir);
  } catch (err) {
    return { outcome: 'blind', reason: `cannot parse ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function refusal(v: ProfileVerdict): string | null {
  if (v.outcome !== 'refused') return null;
  const who = v.profiles.map((p) => `${p.dir}=${p.account || 'signed out'}`).join(', ');
  return `refused: ${v.reason} (${who}); nothing was driven. ${v.next}`;
}
