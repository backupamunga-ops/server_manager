#!/bin/bash
# Mail-stack installation (round-3 steps 3-5, idempotent) — runs on the VPS.
set -uo pipefail

echo "== 1. service files"
install -d /opt/cloudlane/mail-stack /etc/cloudlane/mail
cp /root/round3/mail-stack/package.json /root/round3/mail-stack/smtp-receiver.mjs /opt/cloudlane/mail-stack/
cd /opt/cloudlane/mail-stack
pnpm install --silent > /tmp/mailstack-install.log 2>&1 || { echo "pnpm install FAILED"; tail -6 /tmp/mailstack-install.log; exit 1; }
echo "    deps installed"

echo "== 2. DKIM keypair"
if [ ! -f /etc/cloudlane/mail/dkim.private ]; then
  node -e "const{generateKeyPairSync}=require('crypto');const{publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});require('fs').writeFileSync('/etc/cloudlane/mail/dkim.private',privateKey);require('fs').writeFileSync('/etc/cloudlane/mail/dkim.public',publicKey);"
  echo "    generated"
else
  echo "    exists"
fi

echo "== 3. env tokens"
grep -q MAIL_STACK_TOKEN /etc/cloudlane/api.env 2>/dev/null || echo "MAIL_STACK_TOKEN=$(openssl rand -hex 24)" >> /etc/cloudlane/api.env
grep -q MAIL_STACK_URL /etc/cloudlane/api.env 2>/dev/null || echo "MAIL_STACK_URL=http://127.0.0.1:3901" >> /etc/cloudlane/api.env
grep -q S3_ACCESS_KEY /etc/cloudlane/api.env 2>/dev/null && echo "    S3 creds present" || echo "    !! no S3 creds in api.env"
# API_URL for the stack service
grep -q "^API_URL=" /etc/cloudlane/mail-stack.env 2>/dev/null || {
  echo "API_URL=http://127.0.0.1:3000/api/v1" > /etc/cloudlane/mail-stack.env
  echo "    wrote /etc/cloudlane/mail-stack.env"
}

echo "== 4. systemd unit"
cat > /etc/systemd/system/cloudlane-mail-stack.service <<UNIT
[Unit]
Description=Drevanta Mail Stack (SMTP in + out)
After=network.target cloudlane-api.service

[Service]
Type=simple
WorkingDirectory=/opt/cloudlane/mail-stack
EnvironmentFile=/etc/cloudlane/api.env
EnvironmentFile=/etc/cloudlane/mail-stack.env
Environment=SMTP_PORT=25
Environment=OUTBOUND_PORT=3901
Environment=DKIM_KEY_PATH=/etc/cloudlane/mail/dkim.private
Environment=DKIM_SELECTOR=mail
Environment=S3_ENDPOINT=http://127.0.0.1:3900
ExecStart=/usr/bin/node /opt/cloudlane/mail-stack/smtp-receiver.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now cloudlane-mail-stack > /dev/null 2>&1
sleep 3
echo "== 5. status"
systemctl is-active cloudlane-mail-stack || journalctl -u cloudlane-mail-stack -n 15 --no-pager | tail -15
ss -tlnp | grep -E ":25 |:3901" | head -3

echo "== 6. port 25 probes"
timeout 8 bash -c 'cat < /dev/null > /dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null \
  && echo "    outbound 25: OPEN" || echo "    outbound 25: BLOCKED"
(timeout 5 bash -c 'cat < /dev/null > /dev/tcp/127.0.0.1/25' 2>/dev/null && echo "    inbound 25 listener: YES") || echo "    inbound 25 listener: NO"

echo "== 7. restart API for env pickup"
systemctl restart cloudlane-api
sleep 2
curl -s http://127.0.0.1:3000/health | head -c 50; echo

echo "== 8. DKIM public record"
node -e "const fs=require('fs');const k=fs.readFileSync('/etc/cloudlane/mail/dkim.public','utf8').replace(/-----[^\n]+-----/g,'').replace(/\s+/g,'');console.log('DKIM_TXT=v=DKIM1; k=rsa; p='+k)"
