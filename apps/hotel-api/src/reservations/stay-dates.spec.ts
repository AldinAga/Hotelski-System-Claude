import { MAX_STAY_NIGHTS, validateStayDates } from './stay-dates';

const TODAY = '2026-11-02';

describe('validateStayDates', () => {
  it('accepts a stay from today and counts its nights', () => {
    expect(validateStayDates('2026-11-02', '2026-11-05', TODAY)).toEqual({ ok: true, nights: 3 });
  });

  it('counts nights across a DST change and a leap day by calendar date', () => {
    expect(validateStayDates('2027-03-27', '2027-03-29', TODAY)).toEqual({ ok: true, nights: 2 });
    expect(validateStayDates('2028-02-28', '2028-03-01', TODAY)).toEqual({ ok: true, nights: 2 });
  });

  it.each([
    ['malformed arrival', '1.12.2026', '2026-12-03', 'arrival'],
    ['arrival that does not exist', '2026-02-30', '2026-03-03', 'arrival'],
    ['malformed departure', '2026-12-01', '2026-12-3', 'departure'],
    ['departure that does not exist', '2026-12-01', '2026-13-01', 'departure'],
    ['empty departure', '2026-12-01', '', 'departure'],
  ])('%s: bad_date naming the field', (_name, arrival, departure, field) => {
    expect(validateStayDates(arrival, departure, TODAY)).toEqual({ ok: false, reason: 'bad_date', field });
  });

  it('a value that is not a string at all is bad_date (callers outside HTTP may pass anything)', () => {
    expect(validateStayDates(undefined as unknown as string, '2026-12-01', TODAY)).toEqual({
      ok: false,
      reason: 'bad_date',
      field: 'arrival',
    });
  });

  it.each([
    ['departure equal to arrival', '2026-12-01', '2026-12-01'],
    ['departure before arrival', '2026-12-02', '2026-12-01'],
  ])('%s: departure_not_after_arrival', (_name, arrival, departure) => {
    expect(validateStayDates(arrival, departure, TODAY)).toEqual({
      ok: false,
      reason: 'departure_not_after_arrival',
      field: 'departure',
    });
  });

  it('arrival before today: arrival_in_past; arrival today is fine', () => {
    expect(validateStayDates('2026-11-01', '2026-11-03', TODAY)).toEqual({
      ok: false,
      reason: 'arrival_in_past',
      field: 'arrival',
    });
    expect(validateStayDates('2026-11-02', '2026-11-03', TODAY).ok).toBe(true);
  });

  it(`exactly ${MAX_STAY_NIGHTS} nights pass, one more is too_long`, () => {
    expect(MAX_STAY_NIGHTS).toBe(365);
    // 2026-12-01 + 365 days = 2027-12-01 (no leap day in between).
    expect(validateStayDates('2026-12-01', '2027-12-01', TODAY)).toEqual({ ok: true, nights: 365 });
    expect(validateStayDates('2026-12-01', '2027-12-02', TODAY)).toEqual({
      ok: false,
      reason: 'too_long',
      field: 'departure',
    });
    // Across a leap day: 2028-01-01 + 366 days = 2029-01-01 is 366 nights.
    expect(validateStayDates('2028-01-01', '2028-12-31', TODAY)).toEqual({ ok: true, nights: 365 });
    expect(validateStayDates('2028-01-01', '2029-01-01', TODAY)).toMatchObject({ ok: false, reason: 'too_long' });
  });

  it('a malformed today is a caller bug, not a user error', () => {
    expect(() => validateStayDates('2026-12-01', '2026-12-02', '2.11.2026')).toThrow(TypeError);
  });
});
