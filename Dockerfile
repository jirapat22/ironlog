FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV DB_PATH=/data/ironlog.db

EXPOSE 3000

# Run as the image's normal "node" user, not root (11/11/2026): a bug in the app
# then can't change anything else in the container. The database lives in the
# mounted /data folder, which this user can write to.
USER node

CMD ["node", "server.js"]
