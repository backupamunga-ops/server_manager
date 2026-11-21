// Prints the current TOTP code for the walkthrough user using the server's otplib.
import { authenticator } from 'otplib';
import { createDecipheriv } from 'crypto';
import { execSync } from 'child_process';

const key = Buffer.from(execSync("grep '^MASTER_KEY=' /etc/cloudlane/api.env").toString().split('=')[1].trim(), 'hex');
const userId = execSync(`docker exec cloudlane-postgres psql -U cloudlane -d cloudlane -t -A -c "SELECT id FROM \\"User\\" WHERE email LIKE 'walkthrough%' LIMIT 1"`).toString().trim();
const enc = execSync(`docker exec cloudlane-postgres psql -U cloudlane -d cloudlane -t -A -c "SELECT \\"encryptedSecret\\" FROM \\"MfaFactor\\" WHERE \\"userId\\"='${userId}' LIMIT 1"`).toString().trim();
const buf = Buffer.from(enc, 'base64');
const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
d.setAuthTag(buf.subarray(buf.length - 16));
const secret = Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString();
console.log(authenticator.generate(secret));
