FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm i --only=production
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node","server.mjs"]
