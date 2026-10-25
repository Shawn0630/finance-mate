FROM node:22-slim
WORKDIR /app

# Build tools are a fallback in case better-sqlite3 has no prebuild for the
# target platform and has to compile from source.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=9200
ENV DATA_DIR=/app/data
EXPOSE 9200
VOLUME ["/app/data"]
CMD ["node", "src/server.js"]
