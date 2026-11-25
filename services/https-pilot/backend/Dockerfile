# Requires explicitly approved, already available pinned Node image and local offline npm cache context.
ARG N15_NODE_IMAGE
FROM ${N15_NODE_IMAGE}
WORKDIR /opt/n15
COPY package.json package-lock.json ./
RUN --network=none --mount=from=n15_npm_cache,target=/offline-npm,readonly \
    mkdir /tmp/n15-npm && cp -a /offline-npm/. /tmp/n15-npm/ && \
    npm ci --offline --omit=dev --ignore-scripts --no-audit --no-fund --cache /tmp/n15-npm && rm -r /tmp/n15-npm
COPY config.mjs state.mjs serve.mjs ops.mjs agents-deepseek.mjs verify-build.mjs ./
COPY public/index.html public/pair.mjs ./public/
RUN --network=none node verify-build.mjs
USER 1000:1000
ENV NODE_ENV=production N15_CONFIG=/run/n15-private/app.json
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s CMD ["node","ops.mjs","health"]
CMD ["node","serve.mjs"]
