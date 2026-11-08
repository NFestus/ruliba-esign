import { base32Decode, base32Encode, hotp, newRecoveryCodes, newTotpSecret, totpNow, totpStep } from './totp';

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  // RFC 4226 Appendix D test vectors, secret = "12345678901234567890"
  const rfcSecret = Buffer.from('12345678901234567890');
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];

  it('matches the RFC 4226 HOTP test vectors', () => {
    expected.forEach((code, counter) => expect(hotp(rfcSecret, counter)).toBe(code));
  });

  it('matches the RFC 6238 SHA-1 vector at T=59s (8 digits truncated to 6)', () => {
    // RFC 6238 gives 94287082 for T=59; the 6-digit form is the last six digits.
    const b32 = base32Encode(rfcSecret);
    expect(totpNow(b32, 59_000)).toBe('287082');
  });

  it('round-trips base32', () => {
    const buf = Buffer.from('hello ruliba');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it('accepts the current code and one step of drift, rejects older', () => {
    const secret = newTotpSecret();
    const now = 1_800_000_000_000;
    const code = totpNow(secret, now);
    expect(totpStep(code, secret, now)).toBe(Math.floor(now / 30_000));
    expect(totpStep(code, secret, now + 30_000)).not.toBeNull(); // phone 30 s behind
    expect(totpStep(code, secret, now + 90_000)).toBeNull(); // too old
    expect(totpStep('12345', secret, now)).toBeNull();
  });

  it('makes distinct, well-formed recovery codes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    codes.forEach((c) => expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/));
  });
});
