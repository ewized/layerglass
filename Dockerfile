FROM python:3.13-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 viewer \
    && useradd --uid 10001 --gid viewer --no-create-home viewer \
    && mkdir /data && chown viewer:viewer /data

WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt
RUN mkdir /buffer && chown viewer:viewer /buffer
COPY app.py /app/app.py
COPY cameras.py discovery.py identity.py replay.py /app/
COPY providers /app/providers
COPY static /app/static

# Changing release metadata must not invalidate the FFmpeg/pip layers.
ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Layerglass" \
      org.opencontainers.image.description="A local-first camera viewer for your 3D printer" \
      org.opencontainers.image.source="https://github.com/ewized/layerglass" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
USER viewer

ENV PYTHONUNBUFFERED=1 PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=4s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/healthz',timeout=3).read()"
CMD ["python", "app.py"]
