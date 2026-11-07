// Actions that keep working after the licence expires in safe_mode (SPEC
// section 7, rule 6). This is a legal and operational list, not a commercial
// one: a hotel must still see who is in the house and what was agreed.
//
// Hotel spec section 9: in safe mode the guests in the house can still be
// checked out, their open folios paid and documented, and the day closed;
// nothing new is sold or changed. 1c adds eturista.check_out and export.run.
export const SAFE_MODE_ALLOWED: ReadonlySet<string> = new Set([
  'calendar.view',
  'reservation.view',
  'unit.view',
  'rate.view',
  'user.view',
  // 1b: who is staying (the guest list) stays readable after expiry.
  'guest.view',
  // 1b: the guests in the house leave and pay; their documents can be issued.
  'stay.check_out',
  'folio.view',
  'folio.pay',
  'folio.document',
  // 1b: without a day close, nights of the guests in the house stop being
  // posted and a folio cannot be settled (plan, open question 1; Ruling 5).
  'business_day.view',
  'business_day.close',
  // 1b: reading only; settings.manage, legal_profile.manage, stay.check_in,
  // guest.manage, folio.charge, folio.correct and message.resend stay out.
  'settings.view',
  'legal_profile.view',
  'message.view',
]);
