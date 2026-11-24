# Small image for CI / monitoring:  docker run --rm -v "$PWD:/work" smart-doctor check my-profile
# Pinned to a digest (Dependabot keeps it current); the tag is for readers.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
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
