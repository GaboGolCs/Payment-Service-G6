# ---- Etapa 1: build ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npm run build

# ---- Etapa 2: runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

COPY --from=build /app/dist ./dist

EXPOSE 3000

# Aplica migraciones pendientes y luego arranca el servicio.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/app.js"]
