FROM node:24-bookworm AS browser-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY scripts/compile-browser.ts scripts/compile-browser.ts
COPY tsconfig*.json ./
COPY types types
COPY apps/layerglass/src apps/layerglass/src
COPY apps/backend-contracts/src apps/backend-contracts/src
COPY apps/local-backend/src apps/local-backend/src
COPY apps/demo-backend/src apps/demo-backend/src
RUN ./node_modules/.bin/tsc -p tsconfig.browser.json \
    && ./node_modules/.bin/tsc -p tsconfig.service-worker.json \
    && node scripts/compile-browser.ts

FROM python:3.13-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 viewer \
    && useradd --uid 10001 --gid viewer --no-create-home viewer \
    && mkdir /data && chown viewer:viewer /data

WORKDIR /app
COPY apps/python-backend/requirements.txt /app/apps/python-backend/requirements.txt
RUN pip install --no-cache-dir -r apps/python-backend/requirements.txt
RUN mkdir /buffer && chown viewer:viewer /buffer
COPY apps/python-backend/*.py /app/apps/python-backend/
COPY apps/python-backend/providers /app/apps/python-backend/providers
COPY --from=browser-build /build/dist/browser/apps /opt/layerglass-browser/apps
COPY apps/layerglass/browser-modules.json /app/apps/layerglass/browser-modules.json

# Changing release metadata must not invalidate the FFmpeg/pip layers.
ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="LayerGlass" \
      org.opencontainers.image.description="A local-first camera viewer for your 3D printer" \
      org.opencontainers.image.source="https://github.com/ewized/layerglass" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
USER viewer

ENV PYTHONUNBUFFERED=1 PORT=8080 \
    LAYERGLASS_STATIC_DIR=/opt/layerglass-browser/apps/layerglass/src \
    LAYERGLASS_BROWSER_APPS_DIR=/opt/layerglass-browser/apps
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=4s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/healthz',timeout=3).read()"
CMD ["python", "apps/python-backend/app.py"]
