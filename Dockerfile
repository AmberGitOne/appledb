# Apple Globalcare CRM
#
# Runs anywhere that can run a container: Render, Railway, Fly.io, a VPS,
# Docker Desktop.
#
#   docker build -t aglc-crm .
#   docker run -p 4000:4000 -e DATABASE_URL=postgres://... aglc-crm
#
# No volume is needed. The data lives in PostgreSQL, reached over the
# network, so the container filesystem is disposable and the image can be
# replaced at any time without touching a record.

FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000

# Install dependencies first so this layer caches across code changes.
# ignore-scripts is safe here: pg is pure JavaScript and nothing in the
# production dependency tree needs to compile, so no toolchain is required.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY server ./server
COPY web ./web
COPY scripts ./scripts
COPY data/seed.json data/desks.json ./data/

# Create the schema and load the demo data on first boot only; on later boots
# the existing database is left exactly as it is.
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
