FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV DB_PATH=/data/ironlog.db

EXPOSE 3000

CMD ["node", "server.js"]
