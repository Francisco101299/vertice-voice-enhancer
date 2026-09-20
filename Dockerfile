# VÉRTICE VC-1 — Servidor de "PEGAR SUBTÍTULOS" (FFmpeg nativo)
# ================================================================
# Este contenedor instala el FFmpeg NATIVO del sistema operativo
# (mucho más rápido que la versión WASM que corre en el navegador,
# porque puede usar varios núcleos e instrucciones optimizadas del
# procesador real del servidor) y expone un servidor HTTP simple
# que recibe un video + los subtítulos y devuelve el video con los
# subtítulos ya quemados.
FROM node:20-slim

# ffmpeg trae también ffprobe, que usamos para saber el ancho real
# del video (necesario para el salto de línea del texto).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Misma tipografía que usa la app en el navegador (Roboto Bold), para
# que el resultado se vea igual sin importar dónde se generó.
RUN curl -L -o /app/roboto-bold.ttf https://cdn.jsdelivr.net/npm/connect-fonts-roboto@0.0.5/fonts/default/roboto-bold.ttf

COPY package.json .
RUN npm install --omit=dev

COPY server.js .

ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
