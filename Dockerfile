FROM node:20-slim

# better-sqlite3 trae binarios precompilados para Node 20, pero si por alguna
# razon tuviera que compilar, estas tres cosas son lo que necesita.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Primero solo el package.json: si no cambia, Docker reusa la capa de npm
# install y el deploy tarda segundos en vez de minutos.
COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
