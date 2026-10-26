#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Affiliates } from './affiliates.ts';
import { sqliteStore, type SqliteLike } from './sqlite.ts';

const HELP = `affiliates - scarce invite codes and affiliate links on a SQLite file

Usage: affiliates [--db FILE] [--json] <command>

  invite create <inviterId> [--note TEXT]   mint one invite (prints the code once)
  invite list <inviterId>                   list a user's invites (no codes, only hashes are stored)
  invite revoke <inviteId>                  revoke an unused invite (refunds the quota slot)
  invite redeem <code> <newUserId>          spend an invite
  quota get <userId>                        show total / used / left
  quota set <userId> <total>                give someone more (or fewer) invites
  invitedby <userId>                        who invited this user
  invitees <inviterId>                      who joined on this user's invites
  code <userId>                             the user's affiliate code (created on first call)
  attribute <code> <newUserId>              first-touch affiliate attribution
  affiliateof <userId>                      the affiliate a user is attributed to
  commission <amountCents>                  discount + commission for an amount

Options:
  --db FILE            SQLite file (default $AFFILIATES_DB or ./affiliates.db)
  --prefix P           table prefix (default aff_)
  --default-quota N    invites per user without a custom quota (default 3)
  --ttl-days N         invite lifetime in days, 0 for none (default 30)
  --json               machine-readable output
  -h, --help
`;

async function openDb(file: string): Promise<SqliteLike> {
  if ((globalThis as any).Bun) {
    const mod: any = await import('bun:sqlite' as string);
    return new mod.Database(file, { create: true });
  }
  const mod: any = await import('node:sqlite' as string);
  return new mod.DatabaseSync(file);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      prefix: { type: 'string' },
      'default-quota': { type: 'string' },
      'ttl-days': { type: 'string' },
      note: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const json = values.json === true;
  const [cmd, sub, ...rest] = positionals;
  if (values.help || !cmd) {
    process.stdout.write(HELP);
    return values.help ? 0 : 1;
  }
  const file = values.db ?? process.env.AFFILIATES_DB ?? './affiliates.db';
  const ttlDays = values['ttl-days'] === undefined ? 30 : Number(values['ttl-days']);
  const db = await openDb(file);
  const aff = new Affiliates(sqliteStore(db, values.prefix ? { prefix: values.prefix } : {}), {
    defaultQuota: values['default-quota'] === undefined ? 3 : Number(values['default-quota']),
    inviteTtlMs: ttlDays > 0 ? ttlDays * 86_400_000 : null,
  });
  const need = (v: string | undefined, name: string): string => {
    if (!v) throw new Error(`missing <${name}>`);
    return v;
  };
  const out = (data: unknown, text: string) => {
    process.stdout.write(json ? JSON.stringify(data, null, 2) + '\n' : text + '\n');
  };
  const when = (ms: number | null) => (ms === null ? '-' : new Date(ms).toISOString());

  try {
    if (cmd === 'invite') {
      if (sub === 'create') {
        const inv = await aff.createInvite(need(rest[0], 'inviterId'), values.note ?? '');
        out(inv, `${inv.code}\n(id ${inv.id}, expires ${when(inv.expiresAt)}; the code is shown only once)`);
      } else if (sub === 'list') {
        const list = await aff.invites(need(rest[0], 'inviterId'));
        out(
          list,
          list.length === 0
            ? 'no invites'
            : list
                .map((i) => {
                  const state = i.revokedAt !== null && !i.usedBy ? 'revoked' : i.usedBy ? `used by ${i.usedBy}` : 'open';
                  return `${i.id}  ${when(i.createdAt)}  ${state}${i.note ? `  ${i.note}` : ''}`;
                })
                .join('\n'),
        );
      } else if (sub === 'revoke') {
        const id = need(rest[0], 'inviteId');
        await aff.revokeInvite(id);
        out({ ok: true, id }, `revoked ${id}`);
      } else if (sub === 'redeem') {
        const r = await aff.redeemInvite(need(rest[0], 'code'), need(rest[1], 'newUserId'));
        out(r, r.ok ? `ok: invited by ${r.inviterId}` : `refused: ${r.reason}`);
        return r.ok ? 0 : 2;
      } else throw new Error('usage: invite create|list|revoke|redeem');
    } else if (cmd === 'quota') {
      if (sub === 'set') {
        const user = need(rest[0], 'userId');
        await aff.setQuota(user, Number(need(rest[1], 'total')));
        const q = await aff.quota(user);
        out({ userId: user, ...q }, `${user}: ${q.left} of ${q.total} left`);
      } else if (sub === 'get') {
        const user = need(rest[0], 'userId');
        const q = await aff.quota(user);
        out({ userId: user, ...q }, `${user}: ${q.left} of ${q.total} left (${q.used} used)`);
      } else throw new Error('usage: quota get|set');
    } else if (cmd === 'invitedby') {
      const who = await aff.invitedBy(need(sub, 'userId'));
      out({ userId: sub, invitedBy: who }, who ?? 'nobody');
    } else if (cmd === 'invitees') {
      const list = await aff.invitees(need(sub, 'inviterId'));
      out(list, list.length ? list.map((i) => `${i.userId}  ${when(i.at)}`).join('\n') : 'nobody yet');
    } else if (cmd === 'code') {
      const code = await aff.affiliateCode(need(sub, 'userId'));
      out({ userId: sub, code }, code);
    } else if (cmd === 'attribute') {
      const r = await aff.attribute(need(sub, 'code'), need(rest[0], 'newUserId'));
      out(r, r.ok ? `attributed to ${r.affiliateId}` : r.affiliateId ? `already attributed to ${r.affiliateId}` : 'refused');
      return r.ok ? 0 : 2;
    } else if (cmd === 'affiliateof') {
      const a = await aff.affiliateOf(need(sub, 'userId'));
      out({ userId: sub, affiliateId: a }, a ?? 'none');
    } else if (cmd === 'commission') {
      const amount = Number(need(sub, 'amountCents'));
      const c = aff.commission(amount);
      out({ amountCents: amount, ...c }, `discount ${c.discountCents}c, commission ${c.commissionCents}c`);
    } else {
      throw new Error(`unknown command: ${cmd}`);
    }
    return 0;
  } finally {
    (db as any).close?.();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    else process.stderr.write(`affiliates: ${msg}\n`);
    process.exit(1);
  },
);
