FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./
COPY public ./public
USER node
EXPOSE 2525
HEALTHCHECK --interval=30s CMD wget -qO- http://127.0.0.1:2525/healthz || exit 1
CMD ["node","server.js"]
