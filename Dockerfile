# Apex Construction ERP — production image
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=3000 \
    ERP_DB_FILE=/data/erp.db \
    ERP_TRUST_PROXY=1

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY deploy/entrypoint.sh /usr/local/bin/erp-entrypoint

# The entrypoint fixes /data ownership, then runs the app as the unprivileged "node" user.
RUN chmod 755 /usr/local/bin/erp-entrypoint && mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["erp-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
