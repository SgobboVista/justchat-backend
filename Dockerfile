FROM node:20-bookworm-slim

WORKDIR /app

ARG APP_VERSION=development

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

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
