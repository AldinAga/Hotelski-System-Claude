import { base32Encode, totpGenerate, totpStep, totpUri, totpVerify } from './totp';

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890" (ASCII). The RFC
// prints 8 digits; the 6-digit code is the last six of them.
const SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];
const at = (seconds: number): Date => new Date(seconds * 1000);

describe('totp', () => {
  it('encodes the RFC seed to its well-known base32 form', () => {
    expect(SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it.each(VECTORS)('RFC 6238 SHA-1 vector at %i s', (seconds, eight) => {
    const six = eight.slice(-6);
    expect(totpGenerate(SECRET, at(seconds))).toBe(six);
    expect(totpVerify(SECRET, six, at(seconds), null)).toBe(totpStep(at(seconds)));
  });

  it('59 s gives 287082 (step 1)', () => {
    expect(totpVerify(SECRET, '287082', at(59), null)).toBe(1);
  });

  it('accepts one step either side and nothing further', () => {
    const t = 1111111111;
    const code = totpGenerate(SECRET, at(t));
    const step = totpStep(at(t));
    expect(totpVerify(SECRET, code, at(t + 30), null)).toBe(step);
    expect(totpVerify(SECRET, code, at(t - 30), null)).toBe(step);
    expect(totpVerify(SECRET, code, at(t + 60), null)).toBeNull();
    expect(totpVerify(SECRET, code, at(t - 60), null)).toBeNull();
  });

  it('refuses a step that is not newer than lastStep (replay)', () => {
    const t = 1234567890;
    const code = totpGenerate(SECRET, at(t));
    const step = totpStep(at(t));
    expect(totpVerify(SECRET, code, at(t), step - 1)).toBe(step);
    expect(totpVerify(SECRET, code, at(t), step)).toBeNull();
    expect(totpVerify(SECRET, code, at(t), step + 1)).toBeNull();
  });

  it('refuses malformed codes and secrets without throwing', () => {
    expect(totpVerify(SECRET, '28708', at(59), null)).toBeNull();
    expect(totpVerify(SECRET, '2870820', at(59), null)).toBeNull();
    expect(totpVerify(SECRET, 'abcdef', at(59), null)).toBeNull();
    expect(totpVerify('not base32!', '287082', at(59), null)).toBeNull();
    expect(totpVerify('', '287082', at(59), null)).toBeNull();
  });

  it('builds the otpauth URI with issuer Hotel', () => {
    expect(totpUri('ABC', 'ana@hotel.rs')).toBe('otpauth://totp/Hotel:ana%40hotel.rs?secret=ABC&issuer=Hotel');
  });
});
