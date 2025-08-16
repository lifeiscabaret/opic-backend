// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { OpenAI } from 'openai';
import crypto from 'crypto';

// Node18+/20+ 전역 fetch / FormData / File 사용
const app = express();
const port = process.env.PORT || 8080;

/* ---------------------------------- CORS ---------------------------------- */
const DEFAULT_ORIGINS = [
    'https://illustrious-hummingbird-0af3bb.netlify.app',
    'http://localhost:3000',
];
const allowedOrigins =
    (process.env.ALLOWED_ORIGINS && process.env.ALLOWED_ORIGINS.trim().length > 0)
        ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
        : DEFAULT_ORIGINS;

app.use(cors({
    origin(origin, cb) {
        if (!origin) return cb(null, true);
        const ok = allowedOrigins.includes(origin);
        return ok ? cb(null, true) : cb(new Error(`Not allowed by CORS: ${origin}`), false);
    },
}));
app.options('*', cors());

/* ----------------------------- Body & Uploads ----------------------------- */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
});

/* --------------------------------- Clients -------------------------------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ----------------------------- In-Memory Media ---------------------------- */
const mediaStore = new Map(); // id -> { buf, mime, ts }
const MEDIA_TTL_MS = Number(process.env.MEDIA_TTL_MS || 1000 * 60 * 60);

function putMedia(buf, mime = 'audio/mpeg') {
    const id = crypto.randomUUID();
    mediaStore.set(id, { buf, mime, ts: Date.now() });
    return id;
}
function getMedia(id) {
    const item = mediaStore.get(id);
    if (!item) return null;
    if (Date.now() - item.ts > MEDIA_TTL_MS) {
        mediaStore.delete(id);
        return null;
    }
    return item;
}
setInterval(() => {
    const now = Date.now();
    for (const [id, v] of mediaStore) {
        if (now - v.ts > MEDIA_TTL_MS) mediaStore.delete(id);
    }
}, 60_000);

/* --------------------------------- Health --------------------------------- */
app.get('/', (_req, res) => res.json({ service: 'OPIC Backend', ok: true }));
app.get(['/health', '/api/health'], (_req, res) => {
    res.json({
        ok: true,
        origins: allowedOrigins,
        routes: [
            '/ask', '/api/ask',
            '/tts', '/api/tts',
            '/stt', '/api/stt',
            '/media/tts/:id'
        ],
    });
});

/* ----------------------------------- ASK ---------------------------------- */
app.post(['/ask', '/api/ask'], async (req, res) => {
    try {
        const { question, prompt } = req.body || {};
        const content = (prompt ?? question)?.toString().trim();
        if (!content) return res.status(400).json({ error: 'question_required' });

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are a helpful OPIC practice coach.' },
                { role: 'user', content },
            ],
            temperature: 0.7,
        });

        const answer = completion.choices?.[0]?.message?.content ?? '';
        return res.json({ answer });
    } catch (e) {
        console.error('[ASK ERROR]', e);
        return res.status(500).json({ error: 'server_error' });
    }
});

/* ---------------------------------- TTS ----------------------------------- */
/** OpenAI TTS → MP3 버퍼 저장 후 /media/tts/:id 로 서빙 */
app.post(['/tts', '/api/tts'], async (req, res) => {
    try {
        const { text, voice } = req.body || {};
        const input = (text || '').toString().trim();
        if (!input) return res.status(400).json({ error: 'text_required' });

        // 여성 톤 지향: verse, 실패시 alloy
        const model = process.env.TTS_MODEL || 'tts-1';
        const voiceId = (voice || process.env.TTS_VOICE || 'verse'); // verse → 여성 느낌
        const format = 'mp3';

        const speech = await openai.audio.speech.create({
            model,
            voice: voiceId,
            input,
            format,
        });

        const arrayBuf = await speech.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        const id = putMedia(buf, 'audio/mpeg');

        const audioUrl = `${req.protocol}://${req.get('host')}/media/tts/${id}`;
        return res.json({ audioUrl, model, voice: voiceId, provider: 'openai' });
    } catch (e) {
        console.error('[TTS ERROR]', e?.response?.data || e);
        return res.status(500).json({ error: 'tts_failed' });
    }
});

/* ----------------------------------- STT ---------------------------------- */
/** 프론트에서 FormData('file') 업로드 → OpenAI Transcription 프록시 */
app.post(['/stt', '/api/stt'], upload.single('file'), async (req, res) => {
    try {
        if (!process.env.OPENAI_API_KEY) {
            return res.status(500).json({ error: 'openai_api_key_missing' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'no_file' });
        }
        const filename = req.file.originalname || 'recording.webm';
        const mimetype = req.file.mimetype || 'audio/webm';

        const form = new FormData();
        // 최신 권장: gpt-4o-transcribe (안되면 whisper-1 백업)
        form.append('model', process.env.STT_MODEL || 'gpt-4o-transcribe');
        form.append('file', new File([req.file.buffer], filename, { type: mimetype }));

        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: form,
        });

        const ct = r.headers.get('content-type') || '';
        const raw = await r.text().catch(() => '');
        if (!r.ok) {
            // 에러 원문 전달(빌드/운영에서 문제 원인 바로 확인하려고)
            return res.status(r.status).send(raw || JSON.stringify({ error: 'upstream_error' }));
        }
        const j = ct.includes('application/json') ? JSON.parse(raw) : { text: raw };
        return res.json({ text: j.text || '' });
    } catch (e) {
        console.error('[STT ERROR]', e);
        return res.status(500).json({ error: 'stt_failed' });
    }
});

/* ----------------------------- Serve TTS media ----------------------------- */
// iOS 호환 Range/HEAD
app.head('/media/tts/:id', (req, res) => {
    const item = getMedia(req.params.id);
    if (!item) return res.status(404).end();
    res.setHeader('Content-Type', item.mime || 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Content-Length', String(item.buf.length));
    return res.status(200).end();
});
app.get('/media/tts/:id', (req, res) => {
    const item = getMedia(req.params.id);
    if (!item) return res.status(404).send('Not found');

    const buf = item.buf;
    const total = buf.length;
    const range = req.headers.range;

    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', item.mime || 'audio/mpeg');

    if (!range) {
        res.setHeader('Content-Length', String(total));
        return res.status(200).end(buf);
    }

    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
        res.setHeader('Content-Length', String(total));
        return res.status(200).end(buf);
    }

    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (isNaN(start) || isNaN(end) || start > end || start >= total) {
        return res.status(416).set('Content-Range', `bytes */${total}`).end();
    }
    end = Math.min(end, total - 1);

    const chunk = buf.subarray(start, end + 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', String(chunk.length));
    return res.end(chunk);
});

/* ------------------------------ 404/에러 핸들러 ---------------------------- */
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    console.error('[UNCAUGHT ERROR]', err);
    res.status(500).json({ error: 'server_error' });
});

/* --------------------------------- Listen --------------------------------- */
app.listen(port, () => {
    console.log(`Server on :${port}`);
    console.log('Allowed origins:', allowedOrigins.join(', '));
});
