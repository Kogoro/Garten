# --- build stage: the React app (Vite) – only its output ships in the runtime image
# The output is the same on every architecture, so it is built once on the build machine's own platform
# (no emulation when the release workflow builds the arm64 image).
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
COPY shared ../shared
RUN npm run build

# --- runtime
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
RUN apk add --no-cache git openssh-client \
 && git config --system safe.directory '/data/repos/*'
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY shared ./shared
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 NODE_NO_WARNINGS=1
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
