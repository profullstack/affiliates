import { createHash, randomBytes } from 'node:crypto';

/** Crockford base32 alphabet: no I, L, O, U. */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `n` random Crockford base32 characters from the CSPRNG (5 bits each). */
export function randomCrockford(n: number): string {
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += CROCKFORD[(bytes[i] as number) & 31];
  return out;
}

/** A new invite code, e.g. INV-7K3M-QX9D-2F8H (60 random bits). */
export function generateInviteCode(): string {
  const body = randomCrockford(12);
  return `INV-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/** A new public affiliate code, 8 Crockford characters (40 random bits). */
export function generateAffiliateCode(): string {
  return randomCrockford(8);
}

function crockfordFix(s: string): string {
  return s.replace(/O/g, '0').replace(/[IL]/g, '1');
}

/**
 * Canonical form of a user-typed code: case-insensitive, ignores spaces,
 * dashes and other punctuation, maps the Crockford look-alikes O->0 and I/L->1.
 * Invite codes come back as INV-XXXX-XXXX-XXXX (the INV prefix is optional on
 * input); anything else comes back as uppercase Crockford characters.
 */
export function normalizeCode(input: string): string {
  const s = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length === 15 && s.startsWith('INV')) return formatInvite(crockfordFix(s.slice(3)));
  if (s.length === 12) return formatInvite(crockfordFix(s)); // invite typed without INV-
  return crockfordFix(s);
}

function formatInvite(body: string): string {
  return `INV-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/** sha256 hex of the normalized code. Only this is stored. */
export function hashCode(code: string): string {
  return createHash('sha256').update(normalizeCode(code)).digest('hex');
}

/** Random opaque id for rows. */
export function newId(): string {
  return randomBytes(12).toString('base64url');
}
