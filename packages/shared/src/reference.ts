/**
 * Reference numbers: RCL/<DEPT>/<TYPE>/<YEAR>/<NNNN>, e.g. RCL/PRO/CON/2026/0001.
 * The counter restarts each year per department + document type.
 * The number is assigned when the document passes its final approval
 * (see API ReferenceService), so deleted drafts never leave gaps.
 */
export const REFERENCE_PREFIX = 'RCL';
const CODE = /^[A-Z]{2,5}$/;

export function formatReference(dept: string, type: string, year: number, n: number): string {
  if (!CODE.test(dept)) throw new Error(`Invalid department code: ${dept}`);
  if (!CODE.test(type)) throw new Error(`Invalid document type code: ${type}`);
  if (!Number.isInteger(year) || year < 2000 || year > 2999) throw new Error(`Invalid year: ${year}`);
  if (!Number.isInteger(n) || n < 1 || n > 99999) throw new Error(`Invalid sequence number: ${n}`);
  return `${REFERENCE_PREFIX}/${dept}/${type}/${year}/${String(n).padStart(4, '0')}`;
}

export const REFERENCE_PATTERN = /^RCL\/([A-Z]{2,5})\/([A-Z]{2,5})\/(\d{4})\/(\d{4,5})$/;

export function parseReference(ref: string) {
  const m = REFERENCE_PATTERN.exec(ref.trim().toUpperCase());
  if (!m) return null;
  return { dept: m[1], type: m[2], year: Number(m[3]), number: Number(m[4]) };
}
