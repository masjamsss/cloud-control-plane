# syntax=docker/dockerfile:1
#
# ccp-app — the SPA, built by Vite and served as static files.
#
# REAL (authoritative) mode is a BUILD-TIME fact: Vite inlines
# import.meta.env.VITE_API_BASE into the bundle, which flips src/lib/api.ts from the
# bundled mock to the real ccp-api HTTP client (and src/lib/apiSession.ts's
# isApiMode). So the api URL is a build ARG, not a runtime env, and it is the ONLY
# value baked in — no secrets. An EMPTY VITE_API_BASE builds the DEMO/mock bundle;
# a real deploy MUST pass one. Build:
#     docker build --build-arg VITE_API_BASE=https://ccp.example.com/api -t ccp-app .
# (docker-compose.yml passes it from your .env for you.)
#
# ADR-0023 — VITE_INSTANCE_NAME/VITE_INSTANCE_TAGLINE bake the generic-default
# fallback (empty ⇒ "Cloud Control Plane") into src/brand.ts, same build-arg
# pattern as VITE_API_BASE above. Never required — the runtime identity
# (server-seeded/Settings-renamed) overrides it at runtime regardless.

# ---- build (CI pins Node 20 for the app toolchain; match it for the canonical bundle)
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE=""
ENV VITE_API_BASE=$VITE_API_BASE
ARG VITE_INSTANCE_NAME=""
ENV VITE_INSTANCE_NAME=$VITE_INSTANCE_NAME
ARG VITE_INSTANCE_TAGLINE=""
ENV VITE_INSTANCE_TAGLINE=$VITE_INSTANCE_TAGLINE
# tsc --noEmit && vite build  →  /app/dist
RUN npm run build

# ---- runtime: unprivileged nginx (non-root, listens :8080), static files + SPA fallback
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
# SPA deep-link fallback + fingerprinted-asset caching + a container-local /healthz.
COPY --chown=nginx:nginx nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html
EXPOSE 8080
# busybox wget ships in the alpine base — no extra packages needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
