FROM node:20-slim

WORKDIR /app

# The gateway only needs production dependencies.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js ./

ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

CMD ["node", "index.js"]
