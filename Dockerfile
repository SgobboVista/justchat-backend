FROM node:20-alpine

WORKDIR /app

ARG APP_VERSION=development

LABEL org.opencontainers.image.title="JustChat" \
      org.opencontainers.image.description="Private chat web app by SgobboVista" \
      org.opencontainers.image.vendor="SgobboVista" \
      org.opencontainers.image.authors="SgobboVista" \
      org.opencontainers.image.source="https://github.com/SgobboVista/justchat-backend" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV APP_VERSION="${APP_VERSION}"

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 80

CMD ["npm", "start"]
