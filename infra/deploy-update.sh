#!/bin/bash
# Deploy pending Cloudlane commits from the local VPS clone and restart services.
# Run as root ON the VPS. Expects /opt/cloudlane-src to be the git clone.
set -euo pipefail

SRC=/opt/cloudlane-src
cd "$SRC"

echo "==> Current commit: $(git rev-parse --short HEAD)"

if [[ -f /root/cloudlane-update.patch ]]; then
  echo "==> Applying /root/cloudlane-update.patch"
  git apply --check /root/cloudlane-update.patch 2>/dev/null || true
  if git apply /root/cloudlane-update.patch; then
    git add -A
    git -c user.name=cloudlane-deploy -c user.email=deploy@cloudlane.local commit -m "apply cloudlane-update.patch" || true
  else
    echo "Patch could not be applied — assuming commits already present."
  fi
else
  echo "==> Pulling from origin (no patch file found)"
  git fetch origin
  git reset --hard origin/main
fi

echo "==> Install deps"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo "==> API build"
cd "$SRC/apps/api"
pnpm run build

echo "==> Dashboard build"
cd "$SRC"
pnpm --filter @cloudlane/dashboard build

echo "==> Swap dashboard build"
rm -rf /opt/cloudlane/dashboard.new
cp -r "$SRC/apps/dashboard/build" /opt/cloudlane/dashboard.new
rm -rf /opt/cloudlane/dashboard.old
[[ -d /opt/cloudlane/dashboard ]] && mv /opt/cloudlane/dashboard /opt/cloudlane/dashboard.old
mv /opt/cloudlane/dashboard.new /opt/cloudlane/dashboard

echo "==> Restart API"
systemctl restart cloudlane-api
sleep 6
curl -s -m 5 http://127.0.0.1:3000/health && echo " API OK"

echo "Deployed. Panel bundle updated."
