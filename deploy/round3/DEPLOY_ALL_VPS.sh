#!/bin/bash
# ════════════════════════════════════════════════════════════════════
# Drevanta round 3 — one-shot VPS deployment
#   tools pages + mail attachments API + mail stack (SMTP + MX + DKIM)
# Run as root ON the VPS: bash DEPLOY_ALL_VPS.sh
# ════════════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")"

echo "==> 1. Apply round-3 repo changes (tools + mail API)"
python3 apply_round3.py || echo "    (apply reported issues — check above)"

echo "==> 2. Build + swap"
cd /opt/cloudlane-src
export $(grep -E '^(DATABASE_URL)=' /etc/cloudlane/api.env | xargs) || true
pnpm run build > /tmp/round3-build.log 2>&1 || { echo "BUILD FAILED"; sed 's/\x1b\[[0-9;]*m//g' /tmp/round3-build.log | grep -m8 error; exit 1; }
bash /root/deploy_swap.sh | grep health || echo "    swap: check health manually"

echo "==> 3. Mail stack service"
install -d /opt/cloudlane/mail-stack /etc/cloudlane/mail
cp mail-stack/package.json mail-stack/smtp-receiver.mjs /opt/cloudlane/mail-stack/
cd /opt/cloudlane/mail-stack && pnpm install --silent

if [ ! -f /etc/cloudlane/mail/dkim.private ]; then
  node -e "const{generateKeyPairSync}=require('crypto');const{publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});require('fs').writeFileSync('/etc/cloudlane/mail/dkim.private',privateKey);require('fs').writeFileSync('/etc/cloudlane/mail/dkim.public',publicKey);"
  echo "    generated DKIM keypair"
fi

grep -q MAIL_STACK_TOKEN /etc/cloudlane/api.env 2>/dev/null || {
  echo "MAIL_STACK_TOKEN=$(openssl rand -hex 24)" >> /etc/cloudlane/api.env
  echo "    generated MAIL_STACK_TOKEN"
}
grep -q MAIL_STACK_URL /etc/cloudlane/api.env 2>/dev/null || \
  echo "MAIL_STACK_URL=http://127.0.0.1:3901" >> /etc/cloudlane/api.env

cat > /etc/systemd/system/cloudlane-mail-stack.service <<UNIT
[Unit]
Description=Drevanta Mail Stack (SMTP in + out)
After=network.target cloudlane-api.service

[Service]
Type=simple
WorkingDirectory=/opt/cloudlane/mail-stack
EnvironmentFile=/etc/cloudlane/api.env
Environment=PORT=25
Environment=OUTBOUND_PORT=3901
Environment=DKIM_KEY_PATH=/etc/cloudlane/mail/dkim.private
Environment=DKIM_SELECTOR=mail
ExecStart=/usr/bin/node /opt/cloudlane/mail-stack/smtp-receiver.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now cloudlane-mail-stack
sleep 2
systemctl is-active cloudlane-mail-stack && echo "    mail stack running" || journalctl -u cloudlane-mail-stack -n 12 --no-pager

echo "==> 4. DNS records to add at your DNS provider (per mail domain):"
echo "    Type  Name                          Value"
echo "    MX    <zone>.                       10 <zone>.  (or: 10 server.billucsolutions.co.ke if the zone A-records point here)"
echo "    TXT   <zone>.                       v=spf1 ip4:95.211.164.33 ~all"
echo "    TXT   mail._domainkey.<zone>.       (see: cat /etc/cloudlane/mail/dkim.public → build the TXT below)"
node -e "const fs=require('fs');const k=fs.readFileSync('/etc/cloudlane/mail/dkim.public','utf8').replace(/-----[^\n]+-----/g,'').replace(/\s+/g,'');console.log('    TXT   mail._domainkey.<zone>.       v=DKIM1; k=rsa; p='+k.slice(0,60)+'…(full value printed below)');console.log('FULL_DKIM_TXT=v=DKIM1; k=rsa; p='+k)"
echo "    TXT   _dmarc.<zone>.                v=DMARC1; p=quarantine; rua=mailto:postmaster@<zone>"
echo "    (Also publish an A record for mail.<zone> → 95.211.164.33 if you prefer MX on a dedicated host.)"

echo "==> 5. Port 25 outbound check"
timeout 8 bash -c 'cat < /dev/null > /dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null \
  && echo "    port 25 OUTBOUND is open — external delivery will work" \
  || echo "    port 25 OUTBOUND appears BLOCKED — external delivery needs a relay or provider unlock"

echo "==> Done. Restart the API once so it picks up MAIL_STACK_* env:"
systemctl restart cloudlane-api && echo "    api restarted"
