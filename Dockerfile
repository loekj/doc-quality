FROM node:22-slim
WORKDIR /app

# Install HEIC support + sharp
RUN apt-get update && apt-get install -y --no-install-recommends libheif-dev && rm -rf /var/lib/apt/lists/*
RUN npm init -y > /dev/null 2>&1 && npm install sharp

# Copy server code, HTML pages, and image manifest (images served from S3)
COPY test/fixtures/real/label-server.mjs ./test/fixtures/real/label-server.mjs
COPY test/fixtures/real/label.html ./test/fixtures/real/label.html
COPY test/fixtures/real/review.html ./test/fixtures/real/review.html
COPY test/fixtures/real/manifest.json ./test/fixtures/real/manifest.json

ENV PORT=8080
ENV LABELS_PATH=/data/labels.json
ENV S3_BUCKET_URL=https://doc-quality-labeling.s3.amazonaws.com
ENV NODE_PATH=/app/node_modules
EXPOSE 8080

CMD ["node", "test/fixtures/real/label-server.mjs"]
