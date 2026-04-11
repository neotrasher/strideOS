# StrideOS

Dashboard running self-hosted para:

- sincronizar actividades desde Strava
- cargar historico
- soportar Garmin por archivos en el MVP
- comparar el plan con lo ejecutado
- generar analisis con IA
- desplegar todo en un VPS

## Lo que ya queda montado

- app base con `Next.js` y `TypeScript`
- UI inicial del dashboard
- API minima en `/api/health` y `/api/activities`
- esquema inicial `Prisma` para usuarios, conexiones, actividades, planes y reportes IA
- `Dockerfile` y `docker-compose.yml` para desplegar `app + Postgres`
- `.env.example` con variables base

## Estructura

- `src/app`: frontend y rutas API
- `src/lib`: datos mock y utilidades iniciales
- `prisma/schema.prisma`: modelo de datos MVP
- `Dockerfile`: imagen de la app
- `docker-compose.yml`: stack base para VPS

## Primer arranque local

1. Copia `.env.example` a `.env`.
2. Instala dependencias con `npm install`.
3. Genera cliente Prisma con `npm run prisma:generate`.
4. Arranca con `npm run dev`.

## Arranque en VPS

### Requisitos

- Ubuntu o Debian reciente
- Docker + Docker Compose plugin
- un dominio o subdominio apuntando al VPS
- Nginx o Caddy como reverse proxy

### Pasos

1. Subir este repo al VPS.
2. Crear `.env` con secretos reales.
3. Levantar base y app con `docker compose up -d --build`.
4. Ejecutar migracion inicial con `docker compose --profile ops run --rm migrate`.
5. Publicar la app tras Nginx o Caddy con HTTPS.

## Variables importantes

- `DATABASE_URL`: conexion a Postgres
- `APP_URL`: URL publica del dashboard
- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET`
- `STRAVA_WEBHOOK_SECRET`
- `OPENAI_API_KEY`

## Arquitectura MVP recomendada

### Ingesta

- Strava por OAuth
- Garmin por carga de archivos FIT, GPX o TCX en la primera version

### Persistencia

- Postgres para metadatos
- campo `rawPayload` para guardar respuesta original
- posibilidad de guardar archivos crudos en disco o storage externo

### Flujo

1. El usuario conecta Strava.
2. Se guarda token y refresh token.
3. Un job hace backfill del historico.
4. Se normaliza cada actividad.
5. Se intenta emparejar con una sesion planificada.
6. Se genera reporte IA.
7. Un cron vuelve a consultar nuevas actividades cada pocos minutos.

## Siguiente bloque de trabajo

El siguiente paso tecnico recomendado es implementar estas tres piezas:

1. autenticacion simple
2. conexion OAuth real con Strava
3. persistencia real de `activities` en Postgres

## Estado de verificacion

Quedo verificado en este entorno:

- `npm install`
- `npm run build`
- `npm run prisma:generate`

No he levantado contenedores aqui porque este entorno no tiene Docker disponible, pero la base del proyecto y del despliegue queda preparada para continuar en el VPS.
