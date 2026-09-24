import { fileURLToPath } from 'node:url';

/** The updater and terminal advice share one detection of the launch channel. */
export function runningViaNpx() {
  const ua = process.env.npm_config_user_agent || '';
  const argv1 = process.argv[1] || '';
  let self = '';
  try {
    self = fileURLToPath(import.meta.url);
  } catch {
    /* non-file URL — ignore */
  }
  return /\bnpx\b/.test(ua) || /[\\/]_npx[\\/]/.test(argv1) || /[\\/]_npx[\\/]/.test(self);
}

/** Name the command that launched this process when giving a person a next step. */
export function launchCommand({ viaNpx = runningViaNpx() } = {}) {
  return viaNpx ? 'npx flowviant' : 'flowviant';
}

export function terminalCommand(args = '') {
  return `${launchCommand()}${args ? ` ${args}` : ''}`;
}
