# One image for all three services; the command in docker-compose.yml decides
# which one a container becomes.
#
# BASE_IMAGE is overridable so the lab can be built against a locally-imported
# base in environments where a public registry is unreachable. The default is
# the normal public image and is what you want on a laptop or a free cloud tier.
ARG BASE_IMAGE=node:22-alpine
FROM ${BASE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

# No dependencies to install: every service uses only the Node standard
# library, so there is no npm install step, no lockfile and no supply chain.
COPY services ./services
COPY public ./public

# No EXPOSE: one image backs three services listening on different ports, so a
# single EXPOSE list would misdescribe every container. docker-compose.yml is
# where ports are declared, and only the gateway publishes one.

CMD ["node", "services/api/server.js"]
