import { parseFrom, viaName } from './transports';

describe('sender name on emails', () => {
  it('shows the staff member "via Ruliba eSign"', () => {
    expect(viaName('Grace Uwase')).toBe('Grace Uwase via Ruliba eSign');
  });
  it('cannot be used to inject headers or fake an address', () => {
    expect(viaName('Eve\r\nBcc: x@y.z <boss@ruliba.com> "q"')).toBe('Eve Bcc: x@y.z boss@ruliba.com q via Ruliba eSign');
  });
  it('keeps the configured address', () => {
    expect(parseFrom('Ruliba Clays eSign <sign@ruliba.com>')).toEqual({ name: 'Ruliba Clays eSign', address: 'sign@ruliba.com' });
    expect(parseFrom('sign@ruliba.com')).toEqual({ name: '', address: 'sign@ruliba.com' });
  });
});
