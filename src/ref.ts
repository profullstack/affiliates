/**
 * Cookie name used by @profullstack/referrals (`trackReferralCode` in its `next` adapter defaults
 * `cookieName` to this; its React `ReferralProvider` uses the same string as its sessionStorage key).
 * Sites already on @profullstack/referrals keep setting this one cookie; affiliates reads it and never
 * sets a second one, so one sign-up is counted once.
 */
export const REF_COOKIE = 'referral_code';

/** Query parameter for affiliate links, the same default as @profullstack/referrals (`?ref=`). */
export const REF_PARAM = 'ref';

export type RequestLike = Request | { headers: Headers; url: string };

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep raw */
    }
    return v || null;
  }
  return null;
}

/**
 * The referral/affiliate code a request carries: `?ref=` on the URL first (the click being handled),
 * otherwise the `referral_code` cookie that @profullstack/referrals' middleware set on an earlier
 * visit. Returns null when neither is present. Pass the result to `aff.attribute(code, newUserId)`.
 */
export function refFromRequest(
  req: RequestLike,
  opts: { param?: string; cookieName?: string } = {},
): string | null {
  const param = opts.param ?? REF_PARAM;
  const cookieName = opts.cookieName ?? REF_COOKIE;
  try {
    const q = new URL(req.url, 'http://localhost').searchParams.get(param)?.trim();
    if (q) return q;
  } catch {
    /* unparseable url: fall through to the cookie */
  }
  return readCookie(req.headers.get('cookie'), cookieName)?.trim() || null;
}
