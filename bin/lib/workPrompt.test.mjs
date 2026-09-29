import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_WORK, SYSTEM_WORK_PLAIN } from './prompts.mjs';

test('Terminal work follows the person into the board and long-running processes', () => {
  assert.match(SYSTEM_WORK, /Do not\s+file_card, raise_card, log_work, update_cards, drop_card or deliver_card on your\s+own initiative/);
  assert.match(SYSTEM_WORK, /list_cards.*before filing or taking one/s);
  assert.match(SYSTEM_WORK, /IF THEY ASK YOU TO DELIVER, deliver_card with a summary and committed\s+shas/);
  assert.match(SYSTEM_WORK, /Flowviant-Task: <the card id>/);
  assert.doesNotMatch(SYSTEM_WORK, /LOG DRIFT, don't ask permission|RAISE WHAT YOU SPOT|This session's work is logged as CARDS as it happens/);
  for (const prompt of [SYSTEM_WORK, SYSTEM_WORK_PLAIN]) {
    assert.match(prompt, /Do not start dev servers, watchers or other long-running or background\s+processes unless/);
    assert.match(prompt, /to\s+completion instead of detaching them/);
    assert.match(prompt, /```flowviant-ask/);
  }
  assert.match(SYSTEM_WORK, /Call stream_session_turn with short progress/);
});
