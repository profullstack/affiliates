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
  | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'self' | 'revoked' | 'already_invited' };

/** Result of `attribute`. `external: true` means the code belongs to the site's other referral system. */
export type AttributeResult = { ok: boolean; affiliateId?: string; external?: boolean };

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
}

const DAY = 24 * 60 * 60 * 1000;

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
  private readonly externalCodes: ExternalCodes | undefined;

  constructor(store: AffiliateStore, opts: AffiliatesOptions = {}) {
    this.store = store;
    this.now = opts.now ?? Date.now;
    this.defaultQuota = opts.defaultQuota ?? 3;
    this.inviteTtlMs = opts.inviteTtlMs === undefined ? 30 * DAY : opts.inviteTtlMs;
    this.split = opts.split ?? DEFAULT_SPLIT;
    this.externalCodes = opts.externalCodes;
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
