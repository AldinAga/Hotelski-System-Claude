import { toMailError } from './smtp.transport';

// The line between a permanent and a temporary SMTP failure sits at the class boundaries.
describe('toMailError', () => {
  it.each([
    [500, 'smtp_500', true, 'SMTP server je odbio poruku (odgovor 500).'],
    [550, 'smtp_550', true, 'SMTP server je odbio poruku (odgovor 550).'],
    [599, 'smtp_599', true, 'SMTP server je odbio poruku (odgovor 599).'],
    [400, 'smtp_400', false, 'SMTP server trenutno ne prima poruku (odgovor 400).'],
    [451, 'smtp_451', false, 'SMTP server trenutno ne prima poruku (odgovor 451).'],
    [499, 'smtp_499', false, 'SMTP server trenutno ne prima poruku (odgovor 499).'],
  ])('answer %i is %s (permanent: %s)', (responseCode, code, permanent, message) => {
    expect(toMailError({ responseCode })).toMatchObject({ code, permanent, message });
  });

  it.each([399, 600, 250, 0, 550.5])('answer %p is not a refusal: a temporary connection error', (responseCode) => {
    expect(toMailError({ responseCode })).toMatchObject({
      code: 'smtp_connection',
      permanent: false,
      message: 'Veza sa SMTP serverom nije uspela.',
    });
  });

  it('a code given as text is read as a number; anything else is a connection error', () => {
    expect(toMailError({ responseCode: '550' })).toMatchObject({ code: 'smtp_550', permanent: true });
    for (const err of [{ responseCode: 'abc' }, {}, null, undefined, new Error('ECONNREFUSED')]) {
      expect(toMailError(err)).toMatchObject({ code: 'smtp_connection', permanent: false });
    }
  });
});
