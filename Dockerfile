# The analyze endpoint reports what the deployed grader does, so the grader has
# to be built from the source that was deployed. Shipping a dist/ from a laptop
# would let the two drift, and a stale build answers confidently and wrongly.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm ci && npm run build

FROM node:22-slim
WORKDIR /app

# sharp is a static import of dist/index.js. pdf-to-png-converter and pdfjs-dist
# are dynamic, and the corpus holds 108 PDFs. @napi-rs/canvas gives Node the
# browser surface preflight needs. heic-convert is the only thing here that can
# read HEIC at all — sharp reports the header and then fails on the pixels.
#
# `npm init -y` writes no "type", so Node parses dist/index.js as CommonJS,
# fails, and reparses it as ESM on every boot — it works, but it warns and
# costs time for nothing.
RUN npm init -y > /dev/null 2>&1 \
    && npm pkg set type=module \
    && npm install \
      sharp@^0.33.0 \
      @napi-rs/canvas@~0.1.95 \
      heic-convert \
      pdf-to-png-converter@^3.0.0 \
      pdfjs-dist@^5.4.624

COPY --from=build /app/dist ./dist

# Server code, HTML pages, and image manifest (images served from S3)
COPY test/fixtures/real/label-server.mjs ./test/fixtures/real/label-server.mjs
COPY test/fixtures/real/preflight-worker.mjs ./test/fixtures/real/preflight-worker.mjs
COPY test/fixtures/real/label.html ./test/fixtures/real/label.html
COPY test/fixtures/real/review.html ./test/fixtures/real/review.html
COPY test/fixtures/real/manifest.json ./test/fixtures/real/manifest.json
# Named individually, every one of them, so adding a file the server reads
# means adding it here too. duplicates.json was added and this line was not,
# and the server degraded exactly as written — no skips, no probes, the full
# 5065 served — without a word in the logs to say why.
COPY test/fixtures/real/duplicates.json ./test/fixtures/real/duplicates.json

ENV PORT=8080
ENV LABELS_PATH=/data/labels.json
ENV S3_BUCKET_URL=https://doc-quality-labeling.s3.amazonaws.com
ENV NODE_PATH=/app/node_modules
EXPOSE 8080

CMD ["node", "test/fixtures/real/label-server.mjs"]
