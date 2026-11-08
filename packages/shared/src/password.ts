/**
 * Password rule: at least 12 characters, not all one character class.
 * Length matters more than complexity (NIST SP 800-63B); we avoid forcing
 * symbol soup and periodic resets, which push people to write passwords down.
 */
export const PASSWORD_MIN_LENGTH = 12;

export function passwordProblems(password: string, email?: string): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > 128) problems.push('Use at most 128 characters.');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 2) problems.push('Mix at least two of: lower case, upper case, numbers, symbols.');
  if (/^(.)\1+$/.test(password)) problems.push('Do not repeat a single character.');
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) {
    problems.push('Do not include your email name in the password.');
  }
  const common = ['password', 'ruliba', 'qwerty', '123456', 'welcome', 'letmein', 'admin'];
  if (common.some((c) => password.toLowerCase().includes(c))) {
    problems.push('Avoid common words such as "password" or the company name.');
  }
  return problems;
}
