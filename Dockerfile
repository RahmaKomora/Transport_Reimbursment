# Songa: two images from one repository.
#
#   docker build --target api -t songa-api .    the Express API, port 5175
#   docker build --target web -t songa-web .    nginx serving the built app, port 8080,
#                                               proxying /api to the API in-cluster
#
# The web image is the only one with a public hostname. The browser talks to it alone, and
# it reaches the API by its cluster Service name, so the API needs no ingress of its own.

ARG NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------------------- api -----
FROM ${NODE_IMAGE} AS api
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only. The React, Vite and lint packages are devDependencies and
# never reach this image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Everything the process reads at runtime is under server/: the code, and the schema file
# db.postgres.js applies at startup (server/schema.postgres.sql). Tests, local data and
# uploads are left out by .dockerignore.
COPY server ./server

USER node
EXPOSE 5175
# node directly rather than `npm start`, so SIGTERM from Kubernetes reaches the process and
# it can finish open requests before exiting.
CMD ["node", "server/index.js"]

# -------------------------------------------------------------------------- build -----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js postcss.config.js tailwind.config.js ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------- web -----
FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
# The app is built for /songa/ (vite.config.js `base`), so it is served from there.
COPY --from=build /app/dist /usr/share/nginx/html/songa
# A template: the official entrypoint fills in ${SONGA_API_UPSTREAM} at startup, so the
# same image points at whichever API the environment has.
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
ENV SONGA_API_UPSTREAM=http://songa-api:5175
EXPOSE 8080
