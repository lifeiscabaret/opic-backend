import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { OpenAI } from 'openai';
import fetch from 'node-fetch';
import crypto from 'crypto';

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

/* ---------------------------- Body & Upload Limit --------------------------- */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
});

/* --------------------------------- Clients -------------------------------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ----------------------------- In-Memory Media ----------------------------- */
const mediaStore = new Map();
const MEDIA_TTL_MS = 1000 * 60 * 60; // 1시간
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
app.get(['/health'], (_req, res) =>
    res.json({
        ok: true,
        origins: allowedOrigins,
        routes: ['/ask', '/tts-eleven', '/stt', '/media/tts/:id'],
    })
);

/* ----------------------------------- ASK ---------------------------------- */
app.post(['/ask'], async (req, res) => {
    try {
        const { question, prompt } = req.body || {};
        const content = (prompt ?? question)?.toString().trim();
        if (!content) return res.status(400).json({ error: 'question required' });

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

/* --------------------------- ElevenLabs TTS + 폴백 ------------------------- */
app.post(['/tts-eleven'], async (req, res) => {
    try {
        const { text, voice = 'Rachel' } = req.body || {};
        const input = (text || '').toString().trim();
        if (!input) return res.status(400).json({ error: 'text required' });

        // 1) ElevenLabs 시도
        if (process.env.ELEVEN_API_KEY) {
            try {
                const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
                    method: 'POST',
                    headers: {
                        'xi-api-key': process.env.ELEVEN_API_KEY,
                        'Content-Type': 'application/json',
                        'Accept': 'audio/mpeg',
                    },
                    body: JSON.stringify({ text: input }),
                });
                if (r.ok) {
                    const buf = Buffer.from(await r.arrayBuffer());
                    const id = putMedia(buf, 'audio/mpeg');
                    const audioUrl = `${req.protocol}://${req.get('host')}/media/tts/${id}`;
                    return res.json({ audioUrl, provider: 'elevenlabs', voice });
                } else {
                    console.warn('[ElevenLabs 실패, OpenAI 폴백 사용]');
                }
            } catch (err) {
                console.warn('[ElevenLabs 호출 오류, OpenAI 폴백]', err);
            }
        }

        // 2) OpenAI TTS 폴백
        const speech = await openai.audio.speech.create({
            model: 'tts-1',
            voice: 'alloy',
            input,
            format: 'mp3',
        });
        const arrayBuf = await speech.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        const id = putMedia(buf, 'audio/mpeg');
        const audioUrl = `${req.protocol}://${req.get('host')}/media/tts/${id}`;
        return res.json({ audioUrl, provider: 'openai', voice: 'alloy' });
    } catch (e) {
        console.error('[TTS ERROR]', e);
        return res.status(500).json({ error: 'server_error' });
    }
});

/* ------------------------------- STT 프록시 ------------------------------- */
app.post(['/stt'], upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'no_file' });
        const filename = req.file.originalname || 'recording.webm';
        const mimetype = req.file.mimetype || 'audio/webm';
        const form = new FormData();
        form.append('model', 'whisper-1');
        form.append('file', new File([req.file.buffer], filename, { type: mimetype }));

        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: form,
        });
        if (!r.ok) return res.status(r.status).send(await r.text());
        const j = await r.json();
        return res.json({ text: j.text || '' });
    } catch (e) {
        console.error('[STT ERROR]', e);
        return res.status(500).json({ error: 'stt_failed' });
    }
});

/* ----------------------------- Serve TTS media ----------------------------- */
app.get('/media/tts/:id', (req, res) => {
    const item = getMedia(req.params.id);
    if (!item) return res.status(404).send('Not found');
    res.setHeader('Content-Type', item.mime || 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    return res.end(item.buf);
});

/* --------------------------------- Listen --------------------------------- */
app.listen(port, () => {
    console.log(`Server on :${port}`);
    console.log('Allowed origins:', allowedOrigins.join(', '));
});
