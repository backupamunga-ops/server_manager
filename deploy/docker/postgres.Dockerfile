# Cloudlane Postgres Dockerfile
# Tuned for low-memory (1GB VPS) operation.

FROM postgres:16-alpine

# Copy a custom postgresql.conf fragment tuned for 1GB VPS
COPY deploy/docker/postgres-tuning.conf /docker-entrypoint-initdb.d/

# The tuning is applied via the init script below
