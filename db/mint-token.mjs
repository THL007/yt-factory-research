// Mint a role-pegged access token directly in Neon (bootstrap / recovery).
// Usage: DATABASE_URL=... node db/mint-token.mjs <username> <role> [label] > token-file
// Prints only the token on stdout; save it, it is never stored in plain text.
import { neon } from '@neondatabase/serverless';
import { createHash, randomBytes } from 'node:crypto';
const [username, role, label = ''] = process.argv.slice(2);
if (!username || !role) { console.error('usage: mint-token.mjs <username> <role> [label]'); process.exit(2); }
const sql = neon(process.env.DATABASE_URL);
const [u] = await sql`SELECT id FROM users WHERE username = ${username} AND deleted_at IS NULL`;
const [r] = await sql`SELECT id FROM roles WHERE code = ${role}`;
if (!u || !r) { console.error('unknown user or role'); process.exit(1); }
const token = 'ytf_' + randomBytes(24).toString('hex');
const id = 'tok_' + randomBytes(8).toString('hex');
await sql`INSERT INTO user_roles (user_id, role_id) SELECT ${u.id}, ${r.id} WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id=${u.id} AND role_id=${r.id})`;
await sql`INSERT INTO access_tokens (id, user_id, role_id, label, token_prefix, token_hash, created_by_user_id)
          VALUES (${id}, ${u.id}, ${r.id}, ${label}, ${token.slice(0, 10)}, ${createHash('sha256').update(token).digest('hex')}, ${u.id})`;
process.stdout.write(token + '\n');
console.error(`minted ${id} for ${username} (${role})`);
