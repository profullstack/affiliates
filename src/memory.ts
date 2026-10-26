import type { AffiliateStore, AttributionRow, InviteRow } from './store.ts';

const counted = (r: InviteRow) => r.revokedAt === null || r.usedBy !== null;

/** In-process store for tests and prototypes. Every method body is synchronous, so it is atomic. */
export function memoryStore(): AffiliateStore {
  const quotas = new Map<string, number>();
  const invites = new Map<string, InviteRow>();
  const byHash = new Map<string, string>();
  const codes = new Map<string, string>(); // userId -> code
  const codeOwners = new Map<string, string>(); // code -> userId
  const attributions = new Map<string, AttributionRow>();
  const copy = (r: InviteRow | undefined) => (r ? { ...r } : null);

  return {
    async getQuota(userId) {
      return quotas.has(userId) ? (quotas.get(userId) as number) : null;
    },
    async setQuota(userId, total) {
      quotas.set(userId, total);
    },
    async countInvites(inviterId) {
      let n = 0;
      for (const r of invites.values()) if (r.inviterId === inviterId && counted(r)) n++;
      return n;
    },
    async insertInvite(row, limit) {
      let n = 0;
      for (const r of invites.values()) if (r.inviterId === row.inviterId && counted(r)) n++;
      if (n >= limit) return false;
      if (byHash.has(row.codeHash)) throw new Error('invite code collision');
      invites.set(row.id, { ...row });
      byHash.set(row.codeHash, row.id);
      return true;
    },
    async getInviteByHash(codeHash) {
      const id = byHash.get(codeHash);
      return id ? copy(invites.get(id)) : null;
    },
    async getInvite(id) {
      return copy(invites.get(id));
    },
    async claimInvite(id, userId, at) {
      const r = invites.get(id);
      if (!r || r.usedBy !== null || r.revokedAt !== null) return false;
      r.usedBy = userId;
      r.usedAt = at;
      return true;
    },
    async revokeInvite(id, at) {
      const r = invites.get(id);
      if (r && r.revokedAt === null) r.revokedAt = at;
    },
    async listInvites(inviterId) {
      return [...invites.values()]
        .filter((r) => r.inviterId === inviterId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((r) => ({ ...r }));
    },
    async invitedBy(userId) {
      let best: InviteRow | null = null;
      for (const r of invites.values()) {
        if (r.usedBy === userId && (best === null || (r.usedAt ?? 0) < (best.usedAt ?? 0))) best = r;
      }
      return best ? best.inviterId : null;
    },
    async invitees(inviterId) {
      return [...invites.values()]
        .filter((r) => r.inviterId === inviterId && r.usedBy !== null)
        .sort((a, b) => (a.usedAt ?? 0) - (b.usedAt ?? 0))
        .map((r) => ({ userId: r.usedBy as string, at: r.usedAt as number }));
    },
    async getAffiliateCode(userId) {
      return codes.get(userId) ?? null;
    },
    async putAffiliateCode(userId, code) {
      const existing = codes.get(userId);
      if (existing) return existing;
      if (codeOwners.has(code)) return null;
      codes.set(userId, code);
      codeOwners.set(code, userId);
      return code;
    },
    async affiliateByCode(code) {
      return codeOwners.get(code) ?? null;
    },
    async attribute(row) {
      if (attributions.has(row.userId)) return false;
      attributions.set(row.userId, { ...row });
      return true;
    },
    async getAttribution(userId) {
      const r = attributions.get(userId);
      return r ? { ...r } : null;
    },
  };
}
