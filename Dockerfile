# Nutzen von Node.js als Basis
FROM node:20-alpine

# Arbeitsverzeichnis im Container festlegen
WORKDIR /app

# Kopiere die package.json und installiere Abhängigkeiten
COPY package.json ./
RUN npm install

# Kopiere den restlichen Code (server.js)
COPY . .

# Öffne den Port nach außen
EXPOSE 50070

# Startbefehl
CMD ["npm", "start"]