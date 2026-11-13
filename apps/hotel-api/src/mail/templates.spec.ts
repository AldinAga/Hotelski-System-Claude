import { escapeHtml, formatDay, formatMoney, render, type ReservationPayload } from './templates';

const payload: ReservationPayload = {
  number: 'R-2026-000001',
  holderName: 'Petar Petrović',
  arrival: '2026-11-02',
  departure: '2026-11-04',
  stays: [
    { unitTypeName: 'Dvokrevetna soba', unitName: 'DBL-1', arrival: '2026-11-02', departure: '2026-11-04', adults: 2, children: 0, totalMinor: 2_000_000 },
  ],
  totalMinor: 2_000_000,
  propertyName: 'Demo Hotel',
  propertyEmail: 'recepcija@demo.example',
  propertyPhone: '+381 11 123 456',
};

describe('mail templates', () => {
  it('a confirmation has the title, number, dates 2.11.2026 and the total 20.000,00 RSD in text and HTML', () => {
    const m = render('reservation_confirmed', payload, 'Demo Hotel');
    expect(m.subject).toBe('Potvrda rezervacije R-2026-000001 — Demo Hotel');
    for (const body of [m.text, m.html]) {
      expect(body).toContain('R-2026-000001');
      expect(body).toContain('2.11.2026');
      expect(body).toContain('4.11.2026');
      expect(body).toContain('20.000,00 RSD');
      expect(body).toContain('Dvokrevetna soba (DBL-1)');
    }
    expect(m.text).toContain('Potvrđujemo Vašu rezervaciju');
    expect(m.text).toContain('recepcija@demo.example');
    expect(m.text).toContain('+381 11 123 456');
  });

  it('a holder name <script> is escaped in the HTML and literal in the text', () => {
    const m = render('reservation_confirmed', { ...payload, holderName: '<script>alert(1)</script>' }, 'Demo Hotel');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(m.text).toContain('<script>alert(1)</script>');
  });

  it('every value reaches the HTML escaped: property, unit, contacts', () => {
    const m = render(
      'reservation_confirmed',
      {
        ...payload,
        propertyEmail: 'a"b@x.example',
        propertyPhone: "1'2<3",
        stays: [{ ...payload.stays[0], unitTypeName: 'Soba & more', unitName: '<b>1</b>' }],
      },
      'Hotel <i>Demo</i>',
    );
    expect(m.html).toContain('Hotel &lt;i&gt;Demo&lt;/i&gt;');
    expect(m.html).toContain('Soba &amp; more (&lt;b&gt;1&lt;/b&gt;)');
    expect(m.html).toContain('a&quot;b@x.example');
    expect(m.html).toContain('1&#39;2&lt;3');
    expect(m.html).not.toMatch(/<b>1<\/b>|<i>Demo/);
  });

  it('a cancellation has its own title and text', () => {
    const m = render('reservation_cancelled', payload, 'Demo Hotel');
    expect(m.subject).toBe('Otkazana rezervacija R-2026-000001 — Demo Hotel');
    expect(m.text).toContain('Otkazali smo rezervaciju R-2026-000001');
    expect(m.text).not.toContain('Potvrđujemo');
    expect(m.html).toContain('Otkazali smo rezervaciju');
  });

  it('a stay without a type or unit is called Smeštaj; no contacts, no contact sentence', () => {
    const bare = render(
      'reservation_confirmed',
      { ...payload, propertyEmail: null, propertyPhone: null, stays: [{ ...payload.stays[0], unitTypeName: null, unitName: null }] },
      'Demo Hotel',
    );
    expect(bare.text).toContain('Smeštaj, 2.11.2026 – 4.11.2026');
    expect(bare.text).not.toContain('Možete nas dobiti');
    const unitOnly = render(
      'reservation_confirmed',
      { ...payload, stays: [{ ...payload.stays[0], unitTypeName: null, unitName: 'A-1' }] },
      'Demo Hotel',
    );
    expect(unitOnly.text).toContain('A-1, 2.11.2026');
    const oneContact = render('reservation_confirmed', { ...payload, propertyPhone: null }, 'Demo Hotel');
    expect(oneContact.text).toContain('Možete nas dobiti e-poštom recepcija@demo.example.');
  });

  it('helpers: dates as D.M.YYYY, money as 10.000,00 RSD, escaping of the five characters', () => {
    expect(formatDay('2026-01-05')).toBe('5.1.2026');
    expect(formatMoney(1_000_000)).toBe('10.000,00 RSD');
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
