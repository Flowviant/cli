/** A merge resolution is measured from Git, never the CLI's summary or card
 * receipts (which exclude merge commits). An unreadable fact grants no retry. */
import { git } from './git.mjs';

export function committedMergeResolution(wt, before, base) {
  if (!before || !base) return false;
  try {
    const tip = git(['rev-parse', 'HEAD'], wt);
    if (tip === before) return false;
    if (git(['status', '--porcelain', '--untracked-files=no'], wt)) return false;
    try {
      git(['rev-parse', '--verify', 'MERGE_HEAD'], wt);
      return false;
    } catch { /* no unfinished merge */ }
    git(['merge-base', '--is-ancestor', base, tip], wt);
    return true;
  } catch {
    return false;
  }
}

/** Conflict diagnostics come from Git's captured output, before scrubbing or
 * bounding. Command wrappers and non-conflict refusals never arm a retry. */
export function gitReportedConflict(error) {
  return /^CONFLICT \(/m.test(`${error?.stdout ?? ''}\n${error?.stderr ?? ''}`);
}
