FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev


FROM node:24-alpine

# nsenter (util-linux) is what lets us run commands in the host's namespaces.
# docker-cli/compose drive the host daemon through the mounted socket.
# procps/iproute2/grep replace the busybox builtins, whose flags differ enough
# to matter in container exec mode.
RUN apk add --no-cache \
        util-linux \
        docker-cli \
        docker-cli-compose \
        procps \
        iproute2 \
        grep \
        coreutils \
        findutils \
        bash \
        tzdata \
    && rm -rf /var/cache/apk/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production \
    RC_PORT=8723 \
    RC_BIND=0.0.0.0 \
    RC_HOST_ROOT=/host

EXPOSE 8723

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${RC_PORT}/healthz" >/dev/null 2>&1 || exit 1

# Runs as root deliberately: the whole purpose is privileged host administration.
CMD ["node", "dist/index.js"]
