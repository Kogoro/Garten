# --- build stage: only used to pick the Mermaid bundle out of devDependencies (123 MB unpacked)
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# --- runtime
FROM node:24-alpine
RUN apk add --no-cache git openssh-client \
 && git config --system safe.directory '*'
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/node_modules/mermaid/dist/mermaid.min.js ./vendor/mermaid.min.js
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 NODE_NO_WARNINGS=1
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
