// Shared input checks.
/** Plain mailbox@domain only: no quoting, comments, groups or display names (those are what mail parsers disagree about). */
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL.test(s);

const COMMON_PASSWORDS = new Set(['password', 'password1', 'password12', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'admin-demo-1', 'admin123456', 'changeme123', 'letmein1234', 'welcome1234', 'iloveyou123']);
/** Returns a message when the password is not acceptable, else null. */
export function passwordProblem(pw) {
  const p = String(pw ?? '');
  if (p.length < 10) return 'Password must have at least 10 characters';
  if (p.length > 256) return 'Password must have at most 256 characters';
  if (COMMON_PASSWORDS.has(p.toLowerCase()) || /^(.)\1+$/.test(p)) return 'That password is too common – choose another one';
  return null;
}
