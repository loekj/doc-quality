FROM node:22-slim
WORKDIR /app

# Copy only the server code, HTML, and image manifest (images served from S3)
COPY test/fixtures/real/label-server.mjs ./test/fixtures/real/label-server.mjs
COPY test/fixtures/real/label.html ./test/fixtures/real/label.html
COPY test/fixtures/real/manifest.json ./test/fixtures/real/manifest.json

ENV PORT=8080
ENV LABELS_PATH=/data/labels.json
ENV S3_BUCKET_URL=https://doc-quality-labeling.s3.amazonaws.com
EXPOSE 8080

CMD ["node", "test/fixtures/real/label-server.mjs"]
