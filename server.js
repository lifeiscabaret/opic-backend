// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { OpenAI } from 'openai';
import fetch from 'node-fetch';

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
        if (!origin) return cb(null, true); // 서버 내부/헬스체크 등
        const ok = allowedOrigins.includes(origin);
        return ok ? cb(null, true) : cb(new Error(`Not allowed by CORS: ${origin}`), false);
    },
    credentials: false,
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

/* --------------------------------- Utils ---------------------------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ✅ D‑ID 인증 헤더 (Basic: base64("<API_KEY>:"))
const didAuth =
    'Basic ' + Buffer.from(String(process.env.DID_API_KEY || '') + ':').toString('base64');

/* --------------------------------- Health --------------------------------- */
app.get('/', (_req, res) => res.json({ service: 'OPIC Backend', ok: true }));
app.get(['/health', '/api/health'], (_req, res) =>
    res.json({ ok: true, origins: allowedOrigins, routes: ['/ask', '/api/ask', '/speak', '/api/speak'] })
);

/* ----------------------------------- ASK ---------------------------------- */
app.post(['/ask', '/api/ask'], async (req, res) => {
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

/* ---------------------------------- SPEAK --------------------------------- */
// 텍스트+이미지 → D‑ID 립싱크 영상 생성 후 URL 반환
app.post(['/speak', '/api/speak'], async (req, res) => {
    try {
        const { text, imageUrl, voice = 'en-US-JennyNeural' } = req.body || {};
        if (!text || !imageUrl) {
            return res.status(400).json({ error: 'text and imageUrl required' });
        }
        if (text.trim().length < 3) {
            return res.status(400).json({ error: 'text_too_short', min: 3 });
        }

        if (!process.env.DID_API_KEY) {
            return res.status(500).json({ error: 'did_api_key_missing' });
        }

        // 1) 생성 요청
        const createdRes = await fetch('https://api.d-id.com/talks', {
            method: 'POST',
            headers: {
                Authorization: didAuth,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({
                source_url: imageUrl, // 공개 이미지 URL
                script: {
                    type: 'text',
                    input: text,
                    provider: { type: 'microsoft', voice_id: voice }, // 예: en-US-JennyNeural
                },
                config: { stitch: true, result_format: 'mp4' },
            }),
        });

        const createdText = await createdRes.text();
        const createdCT = createdRes.headers.get('content-type') || '';
        if (!createdRes.ok) {
            return res.status(createdRes.status).json({
                error: 'did_create_failed',
                status: createdRes.status,
                contentType: createdCT,
                body: createdText.slice(0, 800),
            });
        }
        let created;
        try { created = JSON.parse(createdText); }
        catch {
            return res.status(502).json({
                error: 'did_create_not_json',
                contentType: createdCT,
                body: createdText.slice(0, 800),
            });
        }
        if (!created?.id) {
            return res.status(502).json({ error: 'create_failed', detail: created });
        }

        // 2) 상태 폴링 (최대 ~30초)
        let videoUrl = null;
        for (let i = 0; i < 24; i++) {
            await sleep(1250);
            const pollRes = await fetch(`https://api.d-id.com/talks/${created.id}`, {
                headers: { Authorization: didAuth, Accept: 'application/json' },
            });
            const pollText = await pollRes.text();
            const pollCT = pollRes.headers.get('content-type') || '';
            if (!pollRes.ok) {
                return res.status(pollRes.status).json({
                    error: 'did_poll_failed',
                    status: pollRes.status,
                    contentType: pollCT,
                    body: pollText.slice(0, 800),
                });
            }
            let data;
            try { data = JSON.parse(pollText); }
            catch {
                return res.status(502).json({
                    error: 'did_poll_not_json',
                    contentType: pollCT,
                    body: pollText.slice(0, 800),
                });
            }
            if (data?.result_url) { videoUrl = data.result_url; break; }
            if (data?.status === 'error') {
                return res.status(502).json({ error: 'render_error', detail: data });
            }
        }

        if (!videoUrl) return res.status(504).json({ error: 'timeout' });
        return res.json({ videoUrl });
    } catch (e) {
        console.error('[SPEAK ERROR]', e);
        return res.status(500).json({ error: 'server_error' });
    }
});

/* ------------------------------ (옵션) STT 등 ------------------------------ */
// app.post(['/stt','/api/stt'], upload.single('audio'), async (req, res) => { ... });

/* -------------------------- 404/에러 핸들러(JSON) -------------------------- */
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
