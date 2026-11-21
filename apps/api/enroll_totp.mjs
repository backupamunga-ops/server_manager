// One-off: enroll a TOTP factor for the walkthrough user exactly like
// bootstrap does: otplib secret -> SecretsService AES-256-GCM -> MfaFactor row.
import { authenticator } from 'otplib';
import { createCipheriv, randomBytes } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const key = Buffer.from(
  execSync("grep '^MASTER_KEY=' /etc/cloudlane/api.env").toString().split('=')[1].trim(),
  'hex',
);
const encrypt = (plain) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([iv, c.update(plain, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
};

const secret = authenticator.generateSecret();
const userId = execSync(
  `docker exec cloudlane-postgres psql -U cloudlane -d cloudlane -t -A -c "SELECT id FROM \\"User\\" WHERE email LIKE 'walkthrough%' LIMIT 1"`,
).toString().trim();
if (!userId) { console.error('walkthrough user not found'); process.exit(1); }
console.log('enrolling TOTP for user:', userId);
// replace any stale factor from previous attempts
execSync(
  `docker exec cloudlane-postgres psql -U cloudlane -d cloudlane -c "DELETE FROM \\"MfaFactor\\" WHERE \\"userId\\"='${userId}'"`,
);
const enc = encrypt(secret);
const sql = `INSERT INTO "MfaFactor" (id, "userId", type, "encryptedSecret", "enabledAt", "verifiedAt")
SELECT gen_random_uuid(), '${userId}', 'TOTP', '${enc}', now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "MfaFactor" WHERE "userId" = '${userId}')
RETURNING id;`;
const out = execSync(
  `echo "${sql.replace(/"/g, '\\"')}" | docker exec -i cloudlane-postgres psql -U cloudlane -d cloudlane -t -A`,
).toString().trim();
console.log('factor inserted:', out || '(empty output)');

// self-check: decrypt + TOTP verify round-trip
const storedEnc = execSync(
  `docker exec cloudlane-postgres psql -U cloudlane -d cloudlane -t -A -c "SELECT \\"encryptedSecret\\" FROM \\"MfaFactor\\" WHERE \\"userId\\"='${userId}' LIMIT 1"`,
).toString().trim();
if (!storedEnc) {
  console.error('no factor row after insert — aborting');
  process.exit(1);
}
const [ivB, , tagB] = [storedEnc.slice(0, 16), null, storedEnc.slice(-24)];
const { createDecipheriv } = await import('crypto');
const buf = Buffer.from(storedEnc, 'base64');
const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
d.setAuthTag(buf.subarray(buf.length - 16));
const dec = Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString();
const code = authenticator.generate(dec);
console.log('round-trip decrypt:', dec === secret ? 'OK' : 'FAIL', '| sample code generated:', code.length === 6);

// persist the plain secret for the browser script (sandbox keeps it; VPS copy removed)
const local = '/root/.wtotp';
writeFileSync(local, secret + '\n');
execSync('chmod 600 ' + local);
console.log('secret saved on VPS temp file (will be removed after browser reads it)');
