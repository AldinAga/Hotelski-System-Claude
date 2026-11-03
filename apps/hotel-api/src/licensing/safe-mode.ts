// Actions that keep working after the licence expires in safe_mode (SPEC
// section 7, rule 6). This is a legal and operational list, not a commercial
// one: a hotel must still see who is in the house and what was agreed.
//
// Hotel spec section 9. Phase 1a has only the read actions below; 1b/1c add
// stay.check_out, folio.pay, eturista.check_out and export.run, so that guests
// can still be checked out, paid and reported after expiry.
export const SAFE_MODE_ALLOWED: ReadonlySet<string> = new Set([
  'calendar.view',
  'reservation.view',
  'unit.view',
  'rate.view',
  'user.view',
  // 1b: who is staying (the guest list) stays readable after expiry.
  'guest.view',
]);
