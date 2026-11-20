// One-off: create the walkthrough login user using the platform's own argon2+pepper scheme.
import argon2 from 'argon2';
import { readFileSync } from 'fs';

const creds = Object.fromEntries(
  readFileSync('/root/.wcreds', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const salted = creds.W_PASS + ':' + process.env.PASSWORD_PEPPER;
const hash = await argon2.hash(salted, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
const { Client } = await import('pg');
const c = new Client({
  host: '127.0.0.1', port: 5432, user: 'cloudlane', database: 'cloudlane',
  password: process.env.POSTGRES_PASSWORD,
});
await c.connect();
await c.query('DELETE FROM "PasswordCredential" WHERE "userId" IN (SELECT id FROM "User" WHERE email = $1)', [creds.W_EMAIL]);
await c.query('DELETE FROM "User" WHERE email = $1', [creds.W_EMAIL]);
const r = await c.query('INSERT INTO "User" (id, email, role, "isActive", "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, true, now(), now()) RETURNING id', [creds.W_EMAIL, 'OWNER']);
await c.query('INSERT INTO "PasswordCredential" ("userId", "argon2Hash", "pepperVersion", "updatedAt") VALUES ($1, $2, $3, now())', [r.rows[0].id, hash, process.env.PEPPER_VERSION || 1]);
console.log('user created:', r.rows[0].id);
await c.end();
