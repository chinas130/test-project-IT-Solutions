FROM node:20 AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci

FROM deps AS builder
COPY . .

ARG VITE_API_URL=http://localhost:3001
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

FROM node:20-slim AS api
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/server ./server
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "server/index.js"]

FROM nginx:1.27-alpine AS web
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
