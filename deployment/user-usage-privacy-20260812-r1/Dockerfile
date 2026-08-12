ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG BASE_IMAGE
ARG BASE_IMAGE_ID
ARG BASE_RELEASE

USER root

COPY --chown=node:node apply-runtime-patch.mjs /tmp/tuoke-user-usage-privacy-r1.mjs

RUN set -eux; \
    test -s /app/server/dist/routes/user.js; \
    test -s /app/server/dist/routes/user-analytics.js; \
    test -s /app/server/dist/routes/user-wallet.js; \
    test -s /app/server/dist/routes/fallback.js; \
    test -s /app/server/dist/services/consumer-api-keys.js; \
    test -s /app/server/dist/services/resource-user.js; \
    test -s /app/client/dist/index.html; \
    node /tmp/tuoke-user-usage-privacy-r1.mjs /app/server/dist /app/client/dist; \
    rm -f /tmp/tuoke-user-usage-privacy-r1.mjs; \
    node --check /app/server/dist/routes/user.js; \
    node --check /app/server/dist/routes/user-analytics.js; \
    node --check /app/server/dist/routes/user-wallet.js; \
    node --check /app/server/dist/routes/fallback.js; \
    node --check /app/server/dist/services/consumer-api-keys.js; \
    node --check /app/server/dist/services/resource-user.js; \
    node --check /app/client/dist/assets/index-user-usage-privacy-r1.js; \
    grep -Fq '/assets/index-user-usage-privacy-r1.js' /app/client/dist/index.html; \
    ! grep -Fq 'ELSE COALESCE(r.input_tokens, 0)' /app/server/dist/routes/user.js; \
    ! grep -Fq 'ELSE COALESCE(r.output_tokens, 0)' /app/server/dist/routes/user.js; \
    ! grep -Fq 'ELSE COALESCE(r.input_tokens, 0)' /app/server/dist/routes/user-analytics.js; \
    ! grep -Fq 'ELSE COALESCE(r.output_tokens, 0)' /app/server/dist/routes/user-analytics.js; \
    ! grep -Fq 'ELSE COALESCE(wt.input_tokens, 0)' /app/server/dist/routes/user-wallet.js; \
    ! grep -Fq 'ELSE COALESCE(wt.output_tokens, 0)' /app/server/dist/routes/user-wallet.js; \
    ! grep -Fq 'r.input_tokens' /app/server/dist/services/consumer-api-keys.js; \
    ! grep -Fq 'r.output_tokens' /app/server/dist/services/consumer-api-keys.js; \
    grep -Fq 'const inputUsage = `CASE' /app/server/dist/routes/user.js; \
    grep -Fq 'const inputUsage = `CASE' /app/server/dist/routes/user-analytics.js; \
    grep -Fq "fallbackRouter.get('/token-usage', requireAdmin" /app/server/dist/routes/fallback.js; \
    chmod a+r /app/client/dist/index.html /app/client/dist/assets/index-user-usage-privacy-r1.js

LABEL tuoke.release="user-usage-privacy-20260812-r1" \
      tuoke.expected-base="${BASE_IMAGE}" \
      tuoke.expected-base-id="${BASE_IMAGE_ID}" \
      tuoke.expected-base-release="${BASE_RELEASE}"

USER node
