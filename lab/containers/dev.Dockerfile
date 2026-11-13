FROM node:24-bookworm-slim
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
ENV PATH=/deps/node_modules/.bin:$PATH
WORKDIR /work
USER node
