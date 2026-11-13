FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY public ./public
ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080
USER node
CMD ["node", "server/server.mjs"]
