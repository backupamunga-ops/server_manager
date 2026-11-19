/**
 * Workspace seed — reproduces the Cloudlane Interactive Prototype v1.13 sample
 * workspace server-side, so every panel screen shows the same data the
 * prototype showed (sample analytics/delivery/external/maid-finder projects,
 * the central domain registry, database users, cron history, activities).
 * Seed runs once, on the first GET /workspace for a workspace with no projects.
 */
import type { PrismaClient } from '@prisma/client';

const ago = (min: number) => new Date(Date.now() - min * 60000);

export async function seedWorkspace(prisma: PrismaClient, workspaceId: string,
  encrypt: (plain: string) => string): Promise<void> {
  const env = async (projectId: string) => {
    const e = await prisma.environment.create({
      data: { projectId, name: 'production' },
    });
    return e.id;
  };

  // Projects
  const projMaid = await prisma.project.create({
    data: { workspaceId, slug: 'maid-finder', name: 'Maid Finder', createdAt: ago(600) },
  });
  const projPulse = await prisma.project.create({
    data: { workspaceId, slug: 'pulse-analytics', name: 'Pulse Analytics', createdAt: ago(3000) },
  });
  const projDelivery = await prisma.project.create({
    data: { workspaceId, slug: 'delivery-platform', name: 'Delivery Platform', createdAt: ago(2400) },
  });
  const projExternal = await prisma.project.create({
    data: { workspaceId, slug: 'external-services', name: 'External Services', createdAt: ago(1300) },
  });

  const [envMaid, envPulse, envDelivery, envExternal] = await Promise.all([
    env(projMaid.id), env(projPulse.id), env(projDelivery.id), env(projExternal.id),
  ]);

  const secrets = encrypt;
  const seedToken = (() => { let n = 0; return () => `seed-${++n}`; })();

  // Services
  const svcPulse = await prisma.service.create({
    data: {
      projectId: projPulse.id, environmentId: envPulse, name: 'dashboard',
      kind: 'application', role: 'web', source: 'github', framework: 'Next.js',
      observedState: 'running', createdAt: ago(2800), activeDeploymentId: null,
      repoFullName: 'demo/pulse-dashboard', branch: 'main', autoDeploy: true,
      variables: { create: [{ key: 'NODE_ENV', encryptedValue: encrypt('production') }] },
    },
  });
  const svcApi = await prisma.service.create({
    data: {
      projectId: projDelivery.id, environmentId: envDelivery, name: 'delivery-api',
      kind: 'application', role: 'api', source: 'zip', framework: 'NestJS',
      observedState: 'running', createdAt: ago(2300),
      fileName: 'delivery-api.zip',
      variables: { create: [
        { key: 'NODE_ENV', encryptedValue: encrypt('production') },
        { key: 'PORT', encryptedValue: encrypt('3000') },
      ] },
    },
  });
  const svcDb = await prisma.service.create({
    data: {
      projectId: projDelivery.id, environmentId: envDelivery, name: 'delivery-db',
      kind: 'database', role: 'worker', source: 'zip', framework: 'PostgreSQL',
      observedState: 'running', createdAt: ago(2200),
      engine: 'PostgreSQL', engineVersion: '16', databaseName: 'delivery_prod',
      external: false, allowedIp: '', passwordCipher: secrets('demo_' + Math.random().toString(36).slice(2, 12)),
    },
  });
  const svcCron = await prisma.service.create({
    data: {
      projectId: projExternal.id, environmentId: envExternal, name: 'Nightly sync',
      kind: 'cron', role: 'worker', source: 'zip', framework: 'HTTP',
      observedState: 'active', createdAt: ago(1200),
      method: 'POST', targetUrl: 'https://example.org/api/sync',
      schedule: '0 2 * * *', timezone: 'Africa/Nairobi', enabled: true,
    },
  });
  const svcMaidApi = await prisma.service.create({
    data: {
      projectId: projMaid.id, environmentId: envMaid, name: 'maidfinder-api',
      kind: 'application', role: 'api', source: 'github', framework: 'Node.js/Express',
      observedState: 'running', createdAt: ago(570),
      repoFullName: 'demo/maidfinder-api', branch: 'main', autoDeploy: true,
      variables: { create: [
        { key: 'NODE_ENV', encryptedValue: encrypt('production') },
        { key: 'MYSQL_HOST', encryptedValue: encrypt('maidfinder-db.internal') },
      ] },
    },
  });
  const svcMaidAdmin = await prisma.service.create({
    data: {
      projectId: projMaid.id, environmentId: envMaid, name: 'maidfinder-admin',
      kind: 'application', role: 'web', source: 'github', framework: 'Next.js',
      observedState: 'running', createdAt: ago(540),
      repoFullName: 'demo/maidfinder-admin', branch: 'main', autoDeploy: true,
      variables: { create: [{ key: 'NODE_ENV', encryptedValue: encrypt('production') }] },
    },
  });
  const svcMaidDb = await prisma.service.create({
    data: {
      projectId: projMaid.id, environmentId: envMaid, name: 'maidfinder-db',
      kind: 'database', role: 'worker', source: 'zip', framework: 'MySQL',
      observedState: 'running', createdAt: ago(520),
      engine: 'MySQL', engineVersion: '8.4', databaseName: 'maidfinder_prod',
      external: false, allowedIp: '', passwordCipher: secrets('demo_not_real'),
    },
  });
  const svcMaidCron = await prisma.service.create({
    data: {
      projectId: projMaid.id, environmentId: envMaid, name: 'KYC cleanup',
      kind: 'cron', role: 'worker', source: 'zip', framework: 'HTTP',
      observedState: 'active', createdAt: ago(470),
      method: 'POST', targetUrl: 'https://api.example.test/tasks/cleanup',
      schedule: '0 2 * * *', timezone: 'Africa/Nairobi', enabled: true,
    },
  });
  const svcMaidMedia = await prisma.service.create({
    data: {
      projectId: projMaid.id, environmentId: envMaid, name: 'maidfinder-media',
      kind: 'storage', role: 'worker', source: 'zip', framework: 'Object Storage',
      observedState: 'ready', createdAt: ago(450),
      provider: 'External S3-compatible',
    },
  });

  // Deployments (LIVE, with log events matching the prototype sample)
  const dep = (serviceId: string, revision: string, started: number, finished: number,
    logs: { msg: string; level: string }[]) =>
    prisma.deployment.create({
      data: {
        serviceId, status: 'LIVE', stage: 8, revision,
        startedAt: ago(started), finishedAt: ago(finished),
        events: { create: logs.map((l) => ({ message: l.msg, level: l.level as never, stage: 'LIVE' as never, createdAt: ago(finished) })) },
      },
    });
  const depPulse = await dep(svcPulse.id, 'a8f27c1', 810, 804, [
    { msg: '[SOURCE] Retrieved demo/pulse-dashboard · main', level: 'info' },
    { msg: '[BUILD] Next.js build completed', level: 'info' },
    { msg: '[HEALTH] Candidate service healthy', level: 'success' },
    { msg: '[ROUTE] Release activated', level: 'success' },
  ]);
  const depApi = await dep(svcApi.id, 'zip-001', 510, 506, [
    { msg: '[SOURCE] Read delivery-api.zip', level: 'info' },
    { msg: '[BUILD] NestJS build completed', level: 'info' },
    { msg: '[HEALTH] /health returned 200', level: 'success' },
    { msg: '[ROUTE] Release activated', level: 'success' },
  ]);
  const depMaidApi = await dep(svcMaidApi.id, 'sample-api-01', 570, 562, [
    { msg: '[BUILD] Express API compiled (synthetic)', level: 'success' },
    { msg: '[HEALTH] Candidate healthy (simulated)', level: 'success' },
  ]);
  const depMaidAdmin = await dep(svcMaidAdmin.id, 'sample-admin-01', 530, 521, [
    { msg: '[BUILD] Next.js built (synthetic)', level: 'success' },
    { msg: '[ROUTE] HTTPS endpoint assigned (simulated)', level: 'success' },
  ]);
  await prisma.service.update({ where: { id: svcPulse.id }, data: { activeDeploymentId: depPulse.id } });
  await prisma.service.update({ where: { id: svcApi.id }, data: { activeDeploymentId: depApi.id } });
  await prisma.service.update({ where: { id: svcMaidApi.id }, data: { activeDeploymentId: depMaidApi.id } });
  await prisma.service.update({ where: { id: svcMaidAdmin.id }, data: { activeDeploymentId: depMaidAdmin.id } });

  // Platform-generated application URLs (existing Domain model drives real routing)
  for (const [serviceId, host, created] of [
    [svcPulse.id, 'pulse.apps.example.test', 800],
    [svcApi.id, 'api.apps.example.test', 500],
    [svcMaidApi.id, 'maidfinder-api.apps.example.test', 562],
    [svcMaidAdmin.id, 'maidfinder-admin.apps.example.test', 521],
  ] as const) {
    await prisma.domain.create({
      data: { workspaceId, host, status: 'VERIFIED', dnsMode: 'MANUAL', verificationToken: seedToken(), createdAt: ago(created) },
    });
  }

  // Central domain registry (prototype v1.4 sample zones)
  const zoneCom = await prisma.domainZone.create({
    data: { workspaceId, name: 'example.com', status: 'verified', dnsMode: 'manual', createdAt: ago(2100) },
  });
  const zoneOrg = await prisma.domainZone.create({
    data: { workspaceId, name: 'example.org', status: 'pending', dnsMode: 'managed', createdAt: ago(240) },
  });
  for (const [name, zoneId, type] of [
    ['example.com', zoneCom.id, 'apex'],
    ['www.example.com', zoneCom.id, 'subdomain'],
    ['api.example.com', zoneCom.id, 'subdomain'],
    ['admin.example.com', zoneCom.id, 'subdomain'],
    ['example.org', zoneOrg.id, 'apex'],
  ] as const) {
    await prisma.hostname.create({ data: { zoneId, name, type, createdAt: ago(1900) } });
  }
  await prisma.dnsRecord.createMany({ data: [
    { zoneId: zoneCom.id, type: 'A', name: '@', value: '203.0.113.42', ttl: 3600 },
    { zoneId: zoneCom.id, type: 'CNAME', name: 'www', value: 'example.com', ttl: 3600 },
    { zoneId: zoneCom.id, type: 'MX', name: '@', value: 'mail.example.com', priority: 10, ttl: 3600 },
    { zoneId: zoneCom.id, type: 'TXT', name: '@', value: 'v=spf1 -all', ttl: 3600 },
    { zoneId: zoneOrg.id, type: 'TXT', name: '_cloudlane', value: 'cloudlane-verify-demo', ttl: 3600 },
  ] });
  await prisma.mailbox.createMany({ data: [
    { zoneId: zoneCom.id, local: 'admin', quota: 250, createdAt: ago(1800) },
    { zoneId: zoneCom.id, local: 'support', quota: 100, createdAt: ago(1400) },
  ] });
  await prisma.mailAlias.create({
    data: { zoneId: zoneCom.id, local: 'hello', target: 'admin@example.com', createdAt: ago(900) },
  });

  // Database users (prototype ensureDbUsers)
  await prisma.dbUser.createMany({ data: [
    { serviceId: svcDb.id, username: 'delivery_db_app',
      privileges: ['CONNECT', 'USAGE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      passwordCipher: secrets('demo_' + Math.random().toString(36).slice(2, 12)), createdAt: ago(2200) },
    { serviceId: svcMaidDb.id, username: 'maidfinder_db_app',
      privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'INDEX'],
      passwordCipher: secrets('demo_' + Math.random().toString(36).slice(2, 12)), createdAt: ago(520) },
  ] });

  // Cron history + activities
  await prisma.cronRun.create({
    data: { serviceId: svcCron.id, status: 'success', code: '200 OK', durationMs: '416ms', createdAt: ago(250) },
  });
  await prisma.activityItem.createMany({ data: [
    { workspaceId, title: 'Deployment is live', detail: 'dashboard · Pulse Analytics', type: 'deploy', createdAt: ago(800) },
    { workspaceId, title: 'Database provisioned', detail: 'delivery-db · PostgreSQL', type: 'database', createdAt: ago(1200) },
    { workspaceId, title: 'Cron job scheduled', detail: 'Nightly sync · Daily at 02:00', type: 'cron', createdAt: ago(1300) },
  ] });

  // Object storage sample (Maid Finder KYC, synthetic metadata only)
  const bucketKyc = await prisma.bucket.create({
    data: { workspaceId, storageServiceId: svcMaidMedia.id, name: 'maidfinder-kyc',
      privacy: 'private', purpose: 'Sensitive identity verification documents', maxMB: 500, createdAt: ago(440) },
  });
  const bucketProfiles = await prisma.bucket.create({
    data: { workspaceId, storageServiceId: svcMaidMedia.id, name: 'maidfinder-profiles',
      privacy: 'private', purpose: 'Profile photographs', maxMB: 250, createdAt: ago(439) },
  });
  await prisma.storageObject.createMany({ data: [
    { workspaceId, bucketId: bucketKyc.id, key: 'sample-user-001/id-front.jpg', size: 483200, type: 'image/jpeg', createdAt: ago(425) },
    { workspaceId, bucketId: bucketKyc.id, key: 'sample-user-001/id-back.jpg', size: 379000, type: 'image/jpeg', createdAt: ago(424) },
    { workspaceId, bucketId: bucketKyc.id, key: 'sample-user-001/selfie.jpg', size: 299200, type: 'image/jpeg', createdAt: ago(423) },
    { workspaceId, bucketId: bucketProfiles.id, key: 'sample-user-001/avatar.webp', size: 92000, type: 'image/webp', createdAt: ago(420) },
  ] });
  await prisma.storageGrant.create({
    data: { workspaceId, storageServiceId: svcMaidMedia.id, bucketId: bucketKyc.id,
      serviceId: svcMaidApi.id, scope: 'read-write', createdAt: ago(410) },
  });
}
