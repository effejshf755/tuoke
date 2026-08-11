ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG BASE_IMAGE
ARG BASE_IMAGE_ID
ARG BASE_RELEASE

USER root

# This is a server-only overlay. Refuse to build on an unexpected production
# image or silently replace a newer client/admin bundle.
RUN echo '6f2ddcebe8f0ad285c4bcbda07079044dc914e4347bdd7ac261a64572d43267e  /app/server/dist/services/consumer-codex-groups.js' | sha256sum -c - \
    && echo '49de4045200eae7b56e0b90b146a8539fc7cea20c7369ce2087cf8193a4208bf  /app/server/dist/routes/consumer-api-keys.js' | sha256sum -c - \
    && echo '098b83fd284c8ae59a72340d5d3b34a856257f8fa471823db13d2ae874ba49df  /app/server/dist/routes/admin-users.js' | sha256sum -c - \
    && echo 'ef69a9d53e74b1081505d6815b6b8e445019f46e1c1a13fc4d9fe36f88c626fa  /app/client/dist/index.html' | sha256sum -c - \
    && echo '76ab04b5aa702fbfb5c1a1fe5af372eb797e0e7064937378e1e33c6d532ba04f  /app/client/dist/assets/index-recharge-expiry-r1.js' | sha256sum -c - \
    && echo '6f2741eaf5c5e4d3cb0ec87688a4141ae47b97bb3052b91cb00422d31f1b6a9c  /app/client/dist/assets/index-Cbkhjyuo.css' | sha256sum -c -

COPY --chown=node:node server-dist/routes/consumer-api-keys.js /app/server/dist/routes/consumer-api-keys.js
COPY --chown=node:node server-dist/services/consumer-codex-groups.js /app/server/dist/services/consumer-codex-groups.js

RUN rm -f /app/server/dist/routes/consumer-api-keys.js.map /app/server/dist/services/consumer-codex-groups.js.map \
    && chmod a+r /app/server/dist/routes/consumer-api-keys.js /app/server/dist/services/consumer-codex-groups.js \
    && echo 'cba59837768079bde55dad154ee0a520b4236dc41ce6c3e8ec962ca578beaad1  /app/server/dist/routes/consumer-api-keys.js' | sha256sum -c - \
    && echo '009bcbead8f6a8eab1248dbbcfba7f2c8392214d67b18b5a06e7f171d600f38d  /app/server/dist/services/consumer-codex-groups.js' | sha256sum -c - \
    && node --check /app/server/dist/routes/consumer-api-keys.js \
    && node --check /app/server/dist/services/consumer-codex-groups.js \
    && grep -Fq "listConsumerCodexGroupOptions(getDb())" /app/server/dist/routes/consumer-api-keys.js \
    && ! grep -Fq 'getUserBillingMultiplierMilli' /app/server/dist/services/consumer-codex-groups.js

LABEL tuoke.release="user-price-display-20260811-r1" \
      tuoke.expected-base="${BASE_IMAGE}" \
      tuoke.expected-base-id="${BASE_IMAGE_ID}" \
      tuoke.expected-base-release="${BASE_RELEASE}"

USER node
