/**
 * THE WORK LANES STOP AT THE TEARDOWN, EVEN WHILE THE PROCESS LIVES ON (second
 * review of ruling 2026-09-26: deploy during stand-down).
 *
 * Before the drain, every stand-down ran the teardown and then `process.exit`
 * on the same tick. The teardown SIGTERMed the live CLIs, and the code waiting
 * on them never ran again, so a killed turn never settled: it stayed pending on
 * the server and resumed in place on the next run ("Worktrees are kept:
 * in-flight work resumes next run").
 *
 * The drain keeps the process alive after the teardown for as long as a
 * deploy is in flight (standDownExit.mjs). Every continuation that was waiting
 * on a killed CLI would then run. A tab turn's resume-fresh retry would spawn a
 * new CLI that nobody kills. An agent turn would settle as `nothing` and send
 * the agent to Stuck. The wiki would sync a half-written vault.
 *
 * So the teardown closes this gate FIRST, and the two places the daemon spawns
 * a lane's work ask it: runTurn.mjs (every CLI turn: tab, agent, plan,
 * pre-review, wiki) and workAgentCheck.mjs (the project check). Once it is
 * closed, a lane's spawn never starts, and a lane's child that ends never hands
 * back its output. The promise the lane awaits stays pending, which is exactly
 * where `process.exit` used to leave it: no settle, no retry, no sync. A pending
 * promise holds no handle, so it never keeps the process up on its own.
 *
 * The deploy lane runs past the gate: it is what the drain exists for. It asks
 * the gate once, when a claim's answer comes back after the stand-down began,
 * and then does not run the deploy (deploy.mjs).
 *
 * Process-wide by design: there is one teardown per process, and it closes
 * once and for good.
 */

let stopped = false;

/** The teardown's first act (fleet.mjs). Idempotent; never reopens. */
export function stopWorkLanes() {
  stopped = true;
}

/** Whether the teardown has run in this process. */
export function workLanesStopped() {
  return stopped;
}

/** What a lane awaits once the gate is closed: an answer that never comes. */
export function never() {
  return new Promise(() => {});
}
