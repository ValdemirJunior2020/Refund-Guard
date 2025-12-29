FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
EXPOSE 5051

CMD ["node", "server.js"]
