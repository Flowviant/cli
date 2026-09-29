/**
 * WHEN A CREDENTIAL WAS STORED, as a date a person can match against their own
 * memory of setting it up ("I connected that one last month") — `Sep 16`.
 *
 * One home because three terminal sites spelled it independently (SOLID audit
 * 2026-09-26, F168): the collision suffix in `credentials.mjs`
 * (`projectRowLabel`), the `machines` listing, and `flowviant projects` in
 * cli.mjs — each with its own copy of the en-US short-month format and its own
 * decision about when the clause is dropped. The decision is the part that
 * matters and is stated once here: ABSENT OR UNPARSEABLE STAYS ABSENT (null).
 * A credential stored before `savedAt` existed has no date, and inventing one
 * would be the listing asserting a day nobody recorded.
 *
 * Each caller places the returned date in its own sentence; only the date is
 * shared. A leaf module on purpose: `credentials.mjs` imports it, so it must
 * import nothing back (a cycle through the credential store).
 */
export function connectedOn(iso) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
