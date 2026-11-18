# Cloudlane Stalwart Mail Dockerfile
# Uses official Stalwart image, adds Cloudlane config overlay.

FROM stalwart/mail-server:latest

# Config is mounted at runtime via -v /etc/cloudlane/stalwart:/etc/stalwart
# Data is mounted at runtime via -v /var/lib/cloudlane/mail:/var/lib/stalwart

LABEL org.opencontainers.image.title="cloudlane-stalwart"
LABEL org.opencontainers.image.description="Stalwart Mail Server with Cloudlane config overlay"
LABEL org.opencontainers.image.source="https://github.com/backupamunga-ops/server_manager"
