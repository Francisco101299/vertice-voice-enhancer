/**
 * VÉRTICE VC-1 — Servidor de "PEGAR SUBTÍTULOS"
 * ================================================
 * Recibe: el video + los segmentos de subtítulo (texto y tiempos) + el
 * estilo elegido. Devuelve: el mismo video, con los subtítulos quemados,
 * usando el FFmpeg NATIVO del sistema (no la versión WASM del navegador).
 *
 * Reimplementa del lado del servidor EXACTAMENTE la misma lógica que ya
 * usa la app en el navegador (mismo cálculo de tamaño de letra, mismo
 * salto de línea, mismos 5 estilos, mismo truco de textfile= para evitar
 * el problema de comillas/apóstrofes en drawtext) — así el resultado se
 * ve igual sin importar cuál de los dos caminos se use.
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const FONT_PATH = path.join(__dirname, 'roboto-bold.ttf');
const MAX_UPLOAD_MB = 500; // mismo límite que ya usa la app en el navegador
const ALLOWED_ORIGIN = 'https://francisco101299.github.io';

// CORS: restringido a tu dominio de GitHub Pages — así nadie más puede usar
// este servidor (y tu cuota gratis de Render) desde otro sitio.
app.use(cors({ origin: ALLOWED_ORIGIN }));

// Validación básica: rechazamos de entrada cualquier archivo que no se
// declare como video, en vez de dejar que FFmpeg reciba cualquier cosa.
const upload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype && file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('El archivo enviado no es un video (tipo recibido: ' + file.mimetype + ').'));
        }
    }
});

// ---- Los mismos 5 estilos que ya existen en la app (VÉRTICE, Clásico,
// Netflix, Amarillo cine, Impacto) — mismas opciones de drawtext. ----
const SUBTITLE_STYLES = {
    vertice: () =>
        ':fontcolor=0xEAFFF2' +
        ':bordercolor=0x00F260@0.65:borderw=1.6' +
        ':box=1:boxcolor=0x0B1119@0.8:boxborderw=16',
    clasico: () =>
        ':fontcolor=white' +
        ':bordercolor=black@0.85:borderw=2' +
        ':shadowcolor=black@0.65:shadowx=2:shadowy=2' +
        ':box=0',
    netflix: () =>
        ':fontcolor=white' +
        ':box=1:boxcolor=black@0.6:boxborderw=12',
    amarillo: () =>
        ':fontcolor=0xFFE034' +
        ':bordercolor=black@0.9:borderw=2.2' +
        ':box=0',
    impacto: () =>
        ':fontcolor=white' +
        ':bordercolor=black:borderw=3.2' +
        ':box=0'
};

function execFileAsync(cmd, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64, ...options }, (err, stdout, stderr) => {
            if (err) {
                err.stderr = stderr;
                reject(err);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

async function getVideoWidth(filePath) {
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_streams',
            '-select_streams', 'v:0',
            filePath
        ]);
        const info = JSON.parse(stdout);
        const width = info?.streams?.[0]?.width;
        return width || 720; // respaldo conservador, igual que en el navegador
    } catch (err) {
        console.warn('No se pudo leer el ancho del video, usando respaldo:', err.message);
        return 720;
    }
}

// Mismo algoritmo de salto de línea que usa la app en el navegador.
function wrapSubtitleText(text, maxCharsPerLine) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? current + ' ' + word : word;
        if (candidate.length > maxCharsPerLine && current) {
            lines.push(current);
            current = word;
        } else {
            current = candidate;
        }
    }
    if (current) lines.push(current);
    return lines.join('\n');
}

app.post('/burn-subtitles', upload.single('file'), async (req, res) => {
    const jobId = crypto.randomUUID();
    const workDir = path.join(os.tmpdir(), 'vertice-burn-' + jobId);
    const cleanupPaths = [];

    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Falta el archivo de video ("file").' });
        }
        let segments;
        try {
            segments = JSON.parse(req.body.segments || '[]');
        } catch (_) {
            return res.status(400).json({ error: 'El campo "segments" no es JSON válido.' });
        }
        if (!Array.isArray(segments) || segments.length === 0) {
            return res.status(400).json({ error: 'Faltan segmentos de subtítulo.' });
        }
        const styleKey = req.body.style || 'vertice';
        const buildStyle = SUBTITLE_STYLES[styleKey] || SUBTITLE_STYLES.vertice;

        await fsp.mkdir(workDir, { recursive: true });
        cleanupPaths.push(workDir);

        const inputPath = path.join(workDir, 'input.mp4');
        await fsp.rename(req.file.path, inputPath);

        const videoWidth = await getVideoWidth(inputPath);
        const fontSize = Math.max(20, Math.min(56, Math.round(videoWidth * 0.045)));
        const avgCharWidth = fontSize * 0.62; // ajustado para la tipografía Bold
        const maxCharsPerLine = Math.min(38, Math.max(12, Math.floor((videoWidth * 0.92) / avgCharWidth)));

        const filterParts = [];
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const fname = 'seg_' + i + '.txt';
            const fpath = path.join(workDir, fname);
            const wrapped = wrapSubtitleText(String(seg.text || ''), maxCharsPerLine);
            await fsp.writeFile(fpath, wrapped, 'utf8');

            const start = Math.max(0, Number(seg.start) || 0).toFixed(2);
            const end = Math.max(Number(start) + 0.05, Number(seg.end) || 0).toFixed(2);

            filterParts.push(
                'drawtext=textfile=' + fname +
                ':fontfile=' + FONT_PATH.replace(/:/g, '\\:') +
                ':expansion=none' +
                ':fontsize=' + fontSize +
                buildStyle() +
                ':line_spacing=10' +
                ':x=(w-text_w)/2:y=h-text_h-48' +
                ":enable='between(t," + start + "," + end + ")'"
            );
        }
        const filterChain = filterParts.join(',');

        const outputPath = path.join(workDir, 'output.mp4');
        await execFileAsync('ffmpeg', [
            '-y',
            '-i', inputPath,
            '-vf', filterChain,
            '-c:v', 'libx264',
            '-preset', 'fast', // el servidor tiene más CPU real disponible que el navegador
            '-crf', '22',
            '-c:a', 'copy',
            '-movflags', '+faststart',
            outputPath
        ], { cwd: workDir });

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="output.mp4"');
        const stream = fs.createReadStream(outputPath);
        stream.pipe(res);
        stream.on('close', () => cleanup(cleanupPaths));
        stream.on('error', () => cleanup(cleanupPaths));
    } catch (err) {
        console.error('Error en /burn-subtitles:', err);
        cleanup(cleanupPaths);
        res.status(500).json({ error: 'Error procesando el video: ' + (err.stderr || err.message || String(err)).slice(0, 500) });
    }
});

function cleanup(paths) {
    for (const p of paths) {
        fsp.rm(p, { recursive: true, force: true }).catch(() => {});
    }
}

app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'vertice-burn-server' });
});

// Manejador de errores: si multer rechaza el archivo (tipo inválido o
// demasiado grande), devolvemos un JSON claro en vez de la página de
// error genérica de Express.
app.use((err, req, res, next) => {
    if (err) {
        console.warn('Solicitud rechazada:', err.message);
        return res.status(400).json({ error: err.message || 'Solicitud inválida.' });
    }
    next();
});

app.listen(PORT, () => {
    console.log('VÉRTICE burn-server escuchando en el puerto ' + PORT);
});
