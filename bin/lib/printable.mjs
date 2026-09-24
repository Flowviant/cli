/**
 * PRINTABLE(): the CLI's own belt against a server-supplied string it is
 * about to write to a TTY (2026-09-24, the audit's A3 CROSS 8a).
 *
 * `safeName` (credentials.mjs) already stripped C0/DEL/C1 for the same reason
 * the server's own `parseBoxName`/`parseCheckoutPath` did — an escape
 * sequence in a project or box name can clear the screen or, via OSC 52,
 * rewrite the terminal's clipboard — but it stopped at C1 and never scrubbed
 * the BIDI/format controls (U+200E/U+200F, U+202A–U+202E, U+2066–U+2069) that
 * reorder a line to hide or forge part of it: a box named
 * `evil‮txt.crt⁦` reads backwards on a bidi-aware terminal, so
 * "evil" can visually swap places with an extension that was never there.
 *
 * THIS IS A LEAF MODULE ON PURPOSE. `machines.mjs` and `fleet.mjs` both need
 * it, `machines.mjs` deliberately imports nothing from `fleet.mjs`'s world
 * (its own header explains why: it runs before the auth gate, like `stop` and
 * `projects`, and must not pull in the daemon's whole CLI/worktree
 * machinery), and `credentials.mjs` is where `safeName` already lived. A leaf
 * with zero imports is the one shape both can depend on without adding an
 * edge neither wants.
 *
 * THE CHARACTER CLASS IS THE SERVER'S OWN (`stripDisplayControl`,
 * machineBoxes.ts, 2026-09-24) — copied rather than re-derived, because the
 * point of a BELT is that the two ends agree about what counts as printable
 * without either one trusting the other to have applied it. The server scrub
 * is the primary fix (it is what a stale stored row, upserted before this
 * belt existed, is read back through); this is defence in depth, because the
 * terminal is where the harm happens and the CLI should not trust that every
 * string on the wire already passed through it — including a project's own
 * `name`, which reaches every terminal that connects a machine (`login`, the
 * banner, the picker, `projects`, `machines`) and had no scrub at all before
 * `safeName`.
 */
// eslint-disable-next-line no-control-regex
const DISPLAY_CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** Strip the class above. Non-strings pass through unchanged — this is a
 *  scrub, not a coercion, and a caller that hands it `undefined` should get
 *  `undefined` back rather than the string `"undefined"`. */
export function printable(raw) {
  return typeof raw === 'string' ? raw.replace(DISPLAY_CONTROL, '') : raw;
}
