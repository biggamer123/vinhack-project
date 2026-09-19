# Web frontend: build with Vite, serve static files with nginx
FROM node:20-alpine AS build
WORKDIR /web
COPY package.json ./
RUN npm install
COPY . .
ARG VITE_API_URL=/api
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /web/dist /usr/share/nginx/html
EXPOSE 80
