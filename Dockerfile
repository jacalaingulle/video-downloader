# Build the Angular frontend
FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Run the Node.js backend, which also serves the built frontend
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=4000 \
    YTDLP_AUTO_UPDATE=true
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
COPY backend/scripts ./scripts
RUN npm ci --omit=dev
COPY backend/src ./src
COPY --from=frontend /app/frontend/dist/frontend/browser /app/frontend/dist/frontend/browser
RUN chown -R node:node /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
