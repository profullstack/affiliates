/** One invite as persisted. The plaintext code is never stored, only its sha256. */
export interface InviteRow {
  id: string;
  codeHash: string;
  inviterId: string;
  createdAt: number;
  expiresAt: number | null;
  usedBy: string | null;
  usedAt: number | null;
  note: string;
  revokedAt: number | null;
}

export interface AttributionRow {
  userId: string;
  affiliateId: string;
  code: string;
  at: number;
}

/**
 * Persistence contract. Every method is async so SQL and remote stores fit.
 * The two methods that guard scarcity must be atomic in the store itself:
 * `insertInvite` (quota check + insert) and `claimInvite` (single use).
 *
 * "Counted" invites are the ones that use up quota: every invite except one
 * revoked before it was used.
 */
export interface AffiliateStore {
  /** Custom quota for a user, or null when the default applies. */
  getQuota(userId: string): Promise<number | null>;
  setQuota(userId: string, total: number): Promise<void>;
  /** Number of counted invites created by this user. */
  countInvites(inviterId: string): Promise<number>;
  /** Insert only if the inviter has fewer than `limit` counted invites. Returns false when over quota. */
  insertInvite(row: InviteRow, limit: number): Promise<boolean>;
  getInviteByHash(codeHash: string): Promise<InviteRow | null>;
  getInvite(id: string): Promise<InviteRow | null>;
  /**
   * Atomic single use: sets used_by/used_at only where used_by IS NULL, not revoked, and `userId` has
   * not redeemed any invite yet (one invite per invitee, enforced atomically: two concurrent claims of
   * different invites by the same user yield one true). True if this call won.
   */
  claimInvite(id: string, userId: string, at: number): Promise<boolean>;
  revokeInvite(id: string, at: number): Promise<void>;
  /** All invites created by the user, newest first. */
  listInvites(inviterId: string): Promise<InviteRow[]>;
  /** Inviter of the earliest invite this user redeemed. */
  invitedBy(userId: string): Promise<string | null>;
  /** Users who redeemed this inviter's invites, oldest first. */
  invitees(inviterId: string): Promise<{ userId: string; at: number }[]>;

  getAffiliateCode(userId: string): Promise<string | null>;
  /** Insert if the user has none yet. Returns the user's code after the call (existing one wins), or null if `code` collided with another user's. */
  putAffiliateCode(userId: string, code: string, at: number): Promise<string | null>;
  affiliateByCode(code: string): Promise<string | null>;
  /** First touch: insert only if the user has no attribution. True if inserted. */
  attribute(row: AttributionRow): Promise<boolean>;
  getAttribution(userId: string): Promise<AttributionRow | null>;
  /**
   * Optional: true when `code` is not one of ours but belongs to another referral system on the same
   * site (for example an @profullstack/referrals `referral_codes` row). supabaseStore implements it.
   */
  isExternalCode?(code: string): Promise<boolean>;
}
