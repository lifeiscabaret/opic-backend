// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { OpenAI } from 'openai';
import crypto from 'node:crypto';
import { Agent as UndiciAgent, setGlobalDispatcher } from 'undici';
import { toFile } from 'openai/uploads';

const app = express();
const port = process.env.PORT || 8080;

/* ---------------- Keep-Alive (undici 전역 디스패처) ---------------- */
setGlobalDispatcher(new UndiciAgent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 10_000,
    connections: 128,
}));

/* ------------------------------- CORS -------------------------------- */
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

/* ---------------------- Body / Upload ---------------------- */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

// 파일 업로드 (Whisper 전송용)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

/* ----------------------------- OpenAI Client (lazy) ----------------------------- */
let openai = null;
function getOpenAI() {
    if (openai) return openai;
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    openai = new OpenAI({ apiKey: key });
    return openai;
}

/* ----------------------------- Health ------------------------------ */
app.get('/', (_req, res) => res.json({ service: 'OPIC Backend', ok: true }));
app.get(['/health', '/api/health'], (_req, res) => res.json({
    ok: true,
    origins: allowedOrigins,
    routes: ['/api/ask', '/api/tts', '/api/transcribe'],
}));

/* ------------------------------- ASK (GPT 답변) ------------------------------- */
app.post(['/ask', '/api/ask'], async (req, res) => {
    try {
        const { question, prompt } = req.body || {};
        const content = (prompt ?? question)?.toString().trim();
        if (!content) return res.status(400).json({ error: 'question required' });

        const client = getOpenAI();
        if (!client) return res.status(500).json({ error: 'OPENAI_API_KEY missing' });

        const r = await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are an OPIC examiner.' },
                { role: 'user', content }
            ],
            temperature: 0.7,
        });
        const answer = r.choices?.[0]?.message?.content ?? '';
        res.json({ answer });
    } catch (e) {
        console.error('[ASK]', e?.response?.data || e.message);
        res.status(500).json({ error: 'server_error' });
    }
});

/* ------------------------- TTS (OpenAI 음성 생성 + LRU 캐시) ------------------------- */
const TTS_CACHE_LIMIT = Number(process.env.TTS_CACHE_LIMIT || 100);
const ttsCache = new Map(); // key -> Buffer
const ttsKey = (text, voice) =>
    crypto.createHash('md5').update(`${voice}|${text}`).digest('hex');

const ALLOWED_VOICES = new Set([
    'nova', 'shimmer', 'echo', 'onyx', 'fable', 'alloy', 'ash', 'sage', 'coral'
]);

app.post(['/tts', '/api/tts'], async (req, res) => {
    try {
        const { text, voice } = req.body || {};
        if (!text) return res.status(400).json({ error: 'text required' });

        const client = getOpenAI();
        if (!client) return res.status(500).json({ error: 'OPENAI_API_KEY missing' });

        const wanted = String(voice || 'shimmer').toLowerCase();
        const safeVoice = ALLOWED_VOICES.has(wanted) ? wanted : 'shimmer';

        const key = ttsKey(text, safeVoice);
        const hit = ttsCache.get(key);
        if (hit) {
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Length', String(hit.length));
            res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
            return res.end(hit);
        }

        let stream;
        try {
            stream = await client.audio.speech.create({
                model: 'tts-1',
                voice: safeVoice,
                input: text,
                response_format: 'mp3',
            });
        } catch (err) {
            if (safeVoice !== 'alloy') {
                stream = await client.audio.speech.create({
                    model: 'tts-1',
                    voice: 'alloy',
                    input: text,
                    response_format: 'mp3',
                });
            } else {
                throw err;
            }
        }

        const chunks = [];
        for await (const chunk of stream.body) chunks.push(chunk);
        const buf = Buffer.concat(chunks);

        ttsCache.set(key, buf);
        if (ttsCache.size > TTS_CACHE_LIMIT) {
            const oldestKey = ttsCache.keys().next().value;
            ttsCache.delete(oldestKey);
        }

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', String(buf.length));
        res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
        res.end(buf);
    } catch (e) {
        console.error('[TTS]', e?.response?.data || e.message);
        res.status(500).json({ error: 'tts_server_error' });
    }
});

/* ------------------------- TRANSCRIBE (Whisper 음성인식) -------------------------- */
app.post(['/transcribe', '/api/transcribe'], upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' });

        const mime = req.file.mimetype || 'audio/webm';
        const ext =
            (req.file.originalname && req.file.originalname.split('.').pop()) ||
            (mime.includes('/') ? mime.split('/')[1] : 'webm');

        const file = await toFile(req.file.buffer, `recording.${ext}`, { contentType: mime });

        const client = getOpenAI();
        if (!client) return res.status(500).json({ error: 'OPENAI_API_KEY missing' });

        const transcription = await client.audio.transcriptions.create({
            model: 'whisper-1',
            file,
            language: 'en',
        });

        res.json({ text: transcription.text || "" });
    } catch (e) {
        const detail = e?.response?.data || e?.message || e;
        console.error('[TRANSCRIBE]', detail);
        res.status(500).json({ error: 'transcribe_server_error', detail });
    }
});

/* ----------------------------- 404 & Error ----------------------------- */
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));
app.use((err, _req, res, _next) => {
    console.error('[UNCAUGHT]', err);
    res.status(500).json({ error: 'server_error' });
});

/* ------------------------------- Listen + Warm-up ------------------------------- */
app.listen(port, '0.0.0.0', async () => {
    console.log(`Server on :${port}`);
    console.log('Allowed origins:', allowedOrigins.join(', '));

    (async function warmUp() {
        try {
            const client = getOpenAI();
            if (!client) {
                console.log('[Warmup] skipped: no key');
                return;
            }
            console.log('[Warmup] start');
            await client.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: 'ping' }],
                temperature: 0.1,
            });
            const r = await client.audio.speech.create({
                model: 'tts-1',
                voice: 'shimmer',
                input: 'ready',
                response_format: 'mp3',
            });
            await r.body?.cancel?.().catch(() => { });
            console.log('[Warmup] done');
        } catch (e) {
            console.log('[Warmup] skipped:', e?.message || e);
        }
    })();
});
