import { calculateReferral, DEFAULT_SPLIT, type ReferralSplit } from '@profullstack/referrals';
import { generateAffiliateCode, generateInviteCode, hashCode, newId, normalizeCode } from './codes.ts';
import type { AffiliateStore, InviteRow } from './store.ts';

export type Invite = {
  /** Plaintext code. Only returned by createInvite; never stored. */
  code: string;
  id: string;
  inviterId: string;
  createdAt: number;
  expiresAt: number | null;
  usedBy: string | null;
  usedAt: number | null;
  note: string;
};

export type RedeemInviteResult =
  | { ok: true; inviterId: string; inviteId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'self' | 'revoked' | 'already_invited' | 'cycle' };

/**
 * Result of `attribute`. `external: true` means the code belongs to the site's other referral system.
 * `cycle: true` means the affiliate is already in the new user's downline, so linking would loop.
 */
export type AttributeResult = { ok: boolean; affiliateId?: string; external?: boolean; cycle?: boolean };

/** One ancestor in a user's upline. Level 1 is the direct referrer. */
export type UplineEntry = { userId: string; level: number; via: 'link' | 'invite' };

/** One member of a user's downline. Level 1 is someone they referred directly. */
export type DownlineEntry = { userId: string; level: number; at: number; parentId: string };

/** One commission line from `payouts()`. */
export type PayoutLine = { affiliateId: string; level: number; rate: number; cents: number };

/** What one purchase pays out across the buyer's upline. */
export type Payouts = {
  /** Purchase amount the lines were computed on. */
  amountCents: number;
  /** New-customer discount (split.customer), only when the buyer has a direct referrer. */
  discountCents: number;
  /** One line per eligible ancestor, level 1 first. Empty when the buyer has no referrer. */
  lines: PayoutLine[];
  /** Sum of `lines[].cents`. Never more than amountCents - discountCents. */
  totalCents: number;
};

/** Hard ceiling on levels: deep enough for any real plan, shallow enough that a walk stays cheap. */
export const MAX_LEVELS = 10;

/** A check for codes owned by another referral system: a function, or an @profullstack/referrals ReferralStore. */
export type ExternalCodes =
  | ((code: string) => boolean | Promise<boolean>)
  | { getCode(code: string): Promise<unknown | null> };

export interface AffiliatesOptions {
  /** Clock in ms. Default Date.now. */
  now?: () => number;
  /** Invites each user may create unless setQuota says otherwise. Default 3. */
  defaultQuota?: number;
  /** Invite lifetime in ms; null for no expiry. Default 30 days. */
  inviteTtlMs?: number | null;
  /** Commission split passed to @profullstack/referrals. Default DEFAULT_SPLIT (60% affiliate, 20% customer). */
  split?: ReferralSplit;
  /**
   * Codes that belong to an existing referral system (sites already on @profullstack/referrals).
   * When `attribute()` gets a code that is not ours and this says it is theirs, it returns
   * `{ ok: false, external: true }` and records nothing, so the existing flow handles it.
   * Default: the store's `isExternalCode` when it has one (supabaseStore checks `referral_codes`).
   */
  externalCodes?: ExternalCodes;
  /**
   * Commission rate per level of the buyer's upline, as fractions of the purchase: index 0 is the
   * direct referrer (level 1), index 1 their referrer (level 2), and so on, up to MAX_LEVELS.
   *
   * Default `[split.affiliate]`: one level, exactly what `commission()` pays. That is the starter
   * plan; nothing changes for a site that never sets this. A multi-level plan is just a longer
   * array, for example `[0.2, 0.05, 0.02]`. The constructor refuses rates that, with the customer
   * discount, add up to more than the purchase.
   */
  levels?: number[];
  /**
   * Whether an ancestor earns this level (for example: has an active subscription, passed KYC,
   * is not banned). An ineligible ancestor's share is not paid and not passed up (no compression),
   * so it stays with the house; the walk carries on above them. Default: everyone is eligible.
   */
  eligible?: (userId: string, level: number) => boolean | Promise<boolean>;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Validate a level plan: 1..MAX_LEVELS finite rates in [0, 1], and rates plus the customer discount
 * at most the whole purchase. A plan that could pay out more than was paid in is refused up front.
 */
function checkLevels(levels: number[], customer: number): number[] {
  if (!Array.isArray(levels) || levels.length === 0) throw new Error('levels must be a non-empty array');
  if (levels.length > MAX_LEVELS) throw new Error(`levels may have at most ${MAX_LEVELS} entries`);
  for (const r of levels) {
    if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 1) {
      throw new Error('each level rate must be a number from 0 to 1');
    }
  }
  const total = levels.reduce((s, r) => s + r, 0) + (Number(customer) || 0);
  // 1e-9: 0.6 + 0.2 + 0.2 must not fail on float error
  if (total > 1 + 1e-9) {
    throw new Error(`levels plus the customer discount add up to ${total.toFixed(4)}, more than the purchase`);
  }
  return [...levels];
}

function publicInvite(r: InviteRow): Omit<Invite, 'code'> & { revokedAt: number | null } {
  return {
    id: r.id,
    inviterId: r.inviterId,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    usedBy: r.usedBy,
    usedAt: r.usedAt,
    note: r.note,
    revokedAt: r.revokedAt,
  };
}

/** Scarce invite codes plus open affiliate links over any AffiliateStore. */
export class Affiliates {
  readonly store: AffiliateStore;
  readonly now: () => number;
  readonly defaultQuota: number;
  readonly inviteTtlMs: number | null;
  readonly split: ReferralSplit;
  readonly levels: readonly number[];
  private readonly externalCodes: ExternalCodes | undefined;
  private readonly eligible: AffiliatesOptions['eligible'];

  constructor(store: AffiliateStore, opts: AffiliatesOptions = {}) {
    this.store = store;
    this.now = opts.now ?? Date.now;
    this.defaultQuota = opts.defaultQuota ?? 3;
    this.inviteTtlMs = opts.inviteTtlMs === undefined ? 30 * DAY : opts.inviteTtlMs;
    this.split = opts.split ?? DEFAULT_SPLIT;
    this.externalCodes = opts.externalCodes;
    this.eligible = opts.eligible;
    this.levels = Object.freeze(checkLevels(opts.levels ?? [this.split.affiliate], this.split.customer));
  }

  /** Direct referrer: the affiliate link (first touch) wins, else whoever invited them. */
  private async parentOf(userId: string): Promise<{ userId: string; via: 'link' | 'invite' } | null> {
    const linked = await this.affiliateOf(userId);
    if (linked) return { userId: linked, via: 'link' };
    const inviter = await this.store.invitedBy(userId);
    return inviter ? { userId: inviter, via: 'invite' } : null;
  }

  /** True when `ancestor` is `userId` or appears anywhere above them (bounded walk). */
  private async isAtOrAbove(ancestor: string, userId: string): Promise<boolean> {
    if (ancestor === userId) return true;
    for (const a of await this.upline(userId, MAX_LEVELS * 10)) if (a.userId === ancestor) return true;
    return false;
  }

  /**
   * The user's ancestors, nearest first, up to `depth` levels (default: as many as `levels`).
   * Stops at the top of the tree, and at any loop, so bad legacy data can never pay twice.
   */
  async upline(userId: string, depth: number = this.levels.length): Promise<UplineEntry[]> {
    const out: UplineEntry[] = [];
    const seen = new Set<string>([userId]);
    let cur = userId;
    for (let level = 1; level <= depth; level++) {
      const parent = await this.parentOf(cur);
      if (!parent || seen.has(parent.userId)) break;
      seen.add(parent.userId);
      out.push({ userId: parent.userId, level, via: parent.via });
      cur = parent.userId;
    }
    return out;
  }

  /**
   * Everyone below a user, breadth first, up to `depth` levels (default: as many as `levels`):
   * people who joined on their link or their invites, then those people's, and so on. Someone who
   * arrived by link is counted under that affiliate only, matching `parentOf`.
   */
  async downline(userId: string, depth: number = this.levels.length): Promise<DownlineEntry[]> {
    const out: DownlineEntry[] = [];
    const seen = new Set<string>([userId]);
    let frontier = [userId];
    for (let level = 1; level <= depth && frontier.length > 0; level++) {
      const next: string[] = [];
      for (const parentId of frontier) {
        const linked = this.store.attributedTo ? await this.store.attributedTo(parentId) : [];
        const invited = await this.store.invitees(parentId);
        const kids = [...linked];
        for (const i of invited) {
          // An invitee who also arrived on someone's link belongs to that affiliate.
          if (!kids.some((k) => k.userId === i.userId) && !(await this.affiliateOf(i.userId))) kids.push(i);
        }
        for (const k of kids.sort((a, b) => a.at - b.at)) {
          if (seen.has(k.userId)) continue;
          seen.add(k.userId);
          out.push({ userId: k.userId, level, at: k.at, parentId });
          next.push(k.userId);
        }
      }
      frontier = next;
    }
    return out;
  }

  /**
   * What one purchase by `buyerId` pays, level by level up their upline. Call it with the real
   * amount the buyer paid, after payment settles; commissions are only ever a share of a sale,
   * never of a sign-up. Pure calculation: record and pay the lines in your own ledger, keyed by
   * the purchase id so a retry pays once.
   *
   * With the default one-level plan this is exactly `commission()` paid to the direct referrer.
   */
  async payouts(buyerId: string, amountCents: number): Promise<Payouts> {
    const amount = Math.max(0, Math.floor(Number(amountCents) || 0));
    const up = await this.upline(buyerId, this.levels.length);
    const discountCents = up.length > 0 ? Math.floor(amount * this.split.customer) : 0;
    const lines: PayoutLine[] = [];
    for (const a of up) {
      const rate = this.levels[a.level - 1] ?? 0;
      const cents = Math.floor(amount * rate);
      if (cents <= 0) continue;
      if (this.eligible && !(await this.eligible(a.userId, a.level))) continue;
      lines.push({ affiliateId: a.userId, level: a.level, rate, cents });
    }
    const totalCents = lines.reduce((s, l) => s + l.cents, 0);
    return { amountCents: amount, discountCents, lines, totalCents };
  }

  /** True when `code` belongs to the site's other referral system (see `externalCodes`). */
  async isExternalCode(code: string): Promise<boolean> {
    const raw = String(code ?? '').trim();
    if (!raw) return false;
    const ext = this.externalCodes;
    if (typeof ext === 'function') return Boolean(await ext(raw));
    // @profullstack/referrals looks codes up upper-cased and trimmed (validateCode)
    if (ext) return (await ext.getCode(raw.toUpperCase())) != null;
    if (this.store.isExternalCode) return this.store.isExternalCode(raw);
    return false;
  }

  private async total(userId: string): Promise<number> {
    const q = await this.store.getQuota(userId);
    return q ?? this.defaultQuota;
  }

  /** Invites a user may create, has created (revoked-before-use ones are refunded), and has left. */
  async quota(userId: string): Promise<{ total: number; used: number; left: number }> {
    const [total, used] = await Promise.all([this.total(userId), this.store.countInvites(userId)]);
    return { total, used, left: Math.max(0, total - used) };
  }

  /** Admin: set a user's invite allowance (total, not additional). */
  async setQuota(userId: string, total: number): Promise<void> {
    if (!Number.isInteger(total) || total < 0) throw new Error('quota must be a non-negative integer');
    await this.store.setQuota(userId, total);
  }

  /** Mint one invite. Throws Error('no invites left') when the quota is spent. */
  async createInvite(inviterId: string, note = ''): Promise<Invite> {
    if (!inviterId) throw new Error('inviterId required');
    const limit = await this.total(inviterId);
    const createdAt = this.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateInviteCode();
      const row: InviteRow = {
        id: newId(),
        codeHash: hashCode(code),
        inviterId,
        createdAt,
        expiresAt: this.inviteTtlMs === null ? null : createdAt + this.inviteTtlMs,
        usedBy: null,
        usedAt: null,
        note: String(note ?? ''),
        revokedAt: null,
      };
      let inserted: boolean;
      try {
        inserted = await this.store.insertInvite(row, limit);
      } catch (err) {
        // 60-bit code collision: astronomically unlikely, retry with a fresh code
        if (/unique|collision|constraint/i.test(String((err as Error)?.message))) continue;
        throw err;
      }
      if (!inserted) throw new Error('no invites left');
      const { revokedAt: _r, ...pub } = publicInvite(row);
      return { code, ...pub };
    }
    throw new Error('could not mint a unique invite code');
  }

  /**
   * Spend an invite on a new user. Single use; the inviter cannot redeem their own; and a user who
   * already redeemed an invite is refused with `already_invited` without using up the second one.
   */
  async redeemInvite(code: string, newUserId: string): Promise<RedeemInviteResult> {
    if (!code || !newUserId) return { ok: false, reason: 'invalid' };
    const row = await this.store.getInviteByHash(hashCode(code));
    if (!row) return { ok: false, reason: 'invalid' };
    if (row.revokedAt !== null) return { ok: false, reason: 'revoked' };
    if (row.usedBy !== null) return { ok: false, reason: 'used' };
    if (row.inviterId === newUserId) return { ok: false, reason: 'self' };
    const at = this.now();
    if (row.expiresAt !== null && at >= row.expiresAt) return { ok: false, reason: 'expired' };
    if ((await this.store.invitedBy(newUserId)) !== null) return { ok: false, reason: 'already_invited' };
    // An existing user redeeming their own downline's invite would make the tree a loop.
    if (await this.isAtOrAbove(newUserId, row.inviterId)) return { ok: false, reason: 'cycle' };
    const won = await this.store.claimInvite(row.id, newUserId, at);
    if (!won) {
      const again = await this.store.getInvite(row.id);
      if (again && again.usedBy === null) {
        // still free, so the claim lost to this user's own concurrent redeem of another invite
        return { ok: false, reason: again.revokedAt !== null ? 'revoked' : 'already_invited' };
      }
      return { ok: false, reason: 'used' };
    }
    return { ok: true, inviterId: row.inviterId, inviteId: row.id };
  }

  /** Who invited this user (first redeemed invite), or null. */
  invitedBy(userId: string): Promise<string | null> {
    return this.store.invitedBy(userId);
  }

  /** Users who joined on this inviter's invites, oldest first. */
  invitees(inviterId: string): Promise<{ userId: string; at: number }[]> {
    return this.store.invitees(inviterId);
  }

  /** Invites this user created, newest first, without codes (only hashes are stored). Includes revokedAt. */
  async invites(inviterId: string): Promise<(Omit<Invite, 'code'> & { revokedAt: number | null })[]> {
    return (await this.store.listInvites(inviterId)).map(publicInvite);
  }

  /** Revoke an unused invite; it stops working and its quota slot is refunded. */
  async revokeInvite(inviteId: string): Promise<void> {
    await this.store.revokeInvite(inviteId, this.now());
  }

  /** The user's public affiliate code: stable, created on first call, unlimited use. */
  async affiliateCode(userId: string): Promise<string> {
    if (!userId) throw new Error('userId required');
    const existing = await this.store.getAffiliateCode(userId);
    if (existing) return existing;
    for (let attempt = 0; attempt < 8; attempt++) {
      const got = await this.store.putAffiliateCode(userId, generateAffiliateCode(), this.now());
      if (got) return got;
    }
    throw new Error('could not mint a unique affiliate code');
  }

  /**
   * First-touch attribution of a new user to the affiliate who owns `code`. Never overwrites.
   * A code that is not ours but belongs to the site's existing referral system returns
   * `{ ok: false, external: true }` and records nothing.
   */
  async attribute(code: string, newUserId: string): Promise<AttributeResult> {
    if (!code || !newUserId) return { ok: false };
    const norm = normalizeCode(code);
    const affiliateId = norm ? await this.store.affiliateByCode(norm) : null;
    if (!affiliateId) return (await this.isExternalCode(code)) ? { ok: false, external: true } : { ok: false };
    if (affiliateId === newUserId) return { ok: false };
    // Linking someone under their own downline would make the tree a loop.
    if (await this.isAtOrAbove(newUserId, affiliateId)) return { ok: false, cycle: true };
    const inserted = await this.store.attribute({ userId: newUserId, affiliateId, code: norm, at: this.now() });
    if (inserted) return { ok: true, affiliateId };
    const prior = await this.store.getAttribution(newUserId);
    return { ok: false, ...(prior ? { affiliateId: prior.affiliateId } : {}) };
  }

  /** The affiliate a user is attributed to, or null. */
  async affiliateOf(userId: string): Promise<string | null> {
    return (await this.store.getAttribution(userId))?.affiliateId ?? null;
  }

  /** Discount for the new customer and commission for the affiliate, via @profullstack/referrals. */
  commission(amountCents: number): { discountCents: number; commissionCents: number } {
    const r = calculateReferral(amountCents, this.split);
    return { discountCents: r.discountCents, commissionCents: r.commissionCents };
  }
}
