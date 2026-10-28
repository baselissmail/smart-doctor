# Small image for CI / monitoring:  docker run --rm -v "$PWD:/work" smart-doctor check my-profile
# Pinned to a digest (Dependabot keeps it current); the tag is for readers.
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
LABEL org.opencontainers.image.title="smart-doctor" \
      org.opencontainers.image.description="Find out why a SMART on FHIR login fails, locally." \
      org.opencontainers.image.source="https://github.com/baselissmail/smart-doctor" \
      org.opencontainers.image.licenses="MIT"
# Pull patched OS packages on top of the base image.
RUN apk upgrade --no-cache
WORKDIR /opt/smart-doctor
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY bin ./bin
COPY src ./src
WORKDIR /work
USER node
ENTRYPOINT ["node", "/opt/smart-doctor/bin/smart-doctor.js"]
CMD ["--help"]
