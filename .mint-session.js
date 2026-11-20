const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const u = await p.user.findFirst();
  if (!u) {
    process.exit(1);
  }
  const h = crypto.randomBytes(32);
  const hh = crypto.createHash('sha256').update(h).digest('hex');
  const ct = crypto.randomBytes(24).toString('base64url');
  const s = await p.session.create({
    data: {
      userId: u.id,
      handleHash: hh,
      csrfToken: ct,
      expiresAt: new Date(Date.now() + 604800000),
    },
  });
  console.log('COOKIE=' + h.toString('base64url') + '.' + s.id);
  process.exit(0);
})();
