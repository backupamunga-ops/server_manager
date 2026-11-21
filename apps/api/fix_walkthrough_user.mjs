// One-off: fix the walkthrough user — argon2 hash + psql insert using psql
// variables (no shell interpolation of values).
import argon2 from 'argon2';
import { readFileSync, rmSync } from 'fs';
import { execSync } from 'child_process';

const creds = Object.fromEntries(
  readFileSync('/root/.wcreds', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const pepper = execSync("grep '^PASSWORD_PEPPER=' /etc/cloudlane/api.env").toString().split('=')[1].trim().replace(/^"|"$/g, '');
const pv = Number(execSync("grep '^PEPPER_VERSION=' /etc/cloudlane/api.env || echo 1").toString().split('=')[1].trim() || 1);
const hash = await argon2.hash(`${creds.W_PASS}:${pepper}`, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });

const sql = `
DELETE FROM "PasswordCredential" WHERE "userId" IN (SELECT id FROM "User" WHERE email = :'email' OR email = '');
DELETE FROM "User" WHERE email = :'email' OR email = '';
WITH u AS (
  INSERT INTO "User" (id, email, role, "isActive", "createdAt", "updatedAt")
  VALUES (gen_random_uuid(), :'email', 'OWNER', true, now(), now()) RETURNING id
)
INSERT INTO "PasswordCredential" ("userId", "argon2Hash", "pepperVersion", "updatedAt")
SELECT id, :'hash', :'pv', now() FROM u RETURNING "userId";`;
const b64 = Buffer.from(sql).toString('base64');
const out = execSync(
  `printf %s '${b64}' | base64 -d | docker exec -i cloudlane-postgres psql -U cloudlane -d cloudlane -v email='${creds.W_EMAIL}' -v hash='${hash}' -v pv=${pv}`,
  { stdio: ['ignore', 'pipe', 'pipe'] },
).toString().trim();
console.log(out.split('\n').filter((l) => l.startsWith('9') || l.includes('DELETE')).join('\n'));

// self-check: verify what is now in the DB round-trips
const stored = execSync(
  `docker exec cloudlane-postgres psql -U cloudlane -d cloudlane -t -A -c "SELECT c.\\"argon2Hash\\" FROM \\"User\\" u JOIN \\"PasswordCredential\\" c ON c.\\"userId\\" = u.id WHERE u.email='${creds.W_EMAIL}'"`,
).toString().trim();
const ok = stored ? await argon2.verify(stored, `${creds.W_PASS}:${pepper}`) : false;
console.log('stored hash round-trip:', ok ? 'OK' : 'FAIL', '| hash len:', stored.length);
if (!ok) { rmSync('/root/.wcreds'); process.exit(1); }
console.log('walkthrough user ready');
