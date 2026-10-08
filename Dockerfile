# Build stage: full toolchain (TypeScript, devDependencies). Debian-based for prebuilt native binaries.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage: only compiled JS, production dependencies and migrations. No compiler, no tests.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY db ./db
# Never run as root inside the container.
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
