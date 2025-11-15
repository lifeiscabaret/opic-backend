// ✅ 100% ESM (`import`) 방식입니다.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { OpenAI } from 'openai';
import crypto from 'crypto';
// ✅ [수정 1] "node-fetch@3" (ESM 호환) 패키지를 명시적으로 import
import fetch from 'node-fetch';
// ✅ [수정 2] "Keep-Alive" 에이전트 import
import http from 'http';
import https from 'https';

const app = express();
const port = process.env.PORT || 8080;

/* ---------------- Keep-Alive agents (왕복 지연 ↓) ---------------- */
// ✅ [수정 3] "Keep-Alive" 에이전트 정의 (GitHub 코드 100% 복원)
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });
const pickAgent = (u) => {
    try {
        const proto =
            typeof u === 'string' ? new URL(u).protocol : (u?.protocol || 'https:');
        return proto === 'http:' ? httpAgent : httpsAgent;
    } catch {
        return httpsAgent;
    }
};

/* ---------------------------------- CORS ---------------------------------- */
// (기존 CORS 코드 ... )
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
// (기존 Body/Uploads 코드 ...)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
});

/* --------------------------------- Clients -------------------------------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ----------------------------- In-Memory Media ---------------------------- */
// (기존 mediaStore, putMedia, getMedia, setInterval 코드 ... )
const mediaStore = new Map();
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
// (기존 Health 코드 ... )
app.get('/', (_req, res) => res.json({ service: 'OPIC Backend', ok: true }));
app.get(['/health', '/api/health'], (_req, res) => {
    res.json({
        ok: true,
        origins: allowedOrigins,
        routes: [
            '/ask', '/api/ask',
            '/tts', '/api/tts',
            '/stt', '/api/stt',
            '/media/tts/:id',
            '/api/test-did' // 테스트 라우트
        ],
    });
});

/* ----------------------------------- ASK ---------------------------------- */
// (기존 ASK 코드 ... )
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
// (기존 TTS 코드 ... )
app.post(['/tts', '/api/tts'], async (req, res) => {
    try {
        const { text, voice } = req.body || {};
        const input = (text || '').toString().trim();
        if (!input) return res.status(400).json({ error: 'text_required' });
        const model = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
        const VOICES = ['nova', 'shimmer', 'echo', 'onyx', 'fable', 'alloy', 'ash', 'sage', 'coral'];
        const requested = (voice || process.env.TTS_VOICE || 'sage').toLowerCase();
        const voiceId = VOICES.includes(requested) ? requested : 'sage';
        const format = 'mp3';
        const speech = await openai.audio.speech.create({ model, voice: voiceId, input, format });
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
// (기존 STT 코드 ... )
app.post(['/stt', '/api/stt'], upload.single('file'), async (req, res) => {
    try {
        if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'openai_api_key_missing' });
        if (!req.file) return res.status(400).json({ error: 'no_file' });
        const filename = req.file.originalname || 'recording.webm';
        const mimetype = req.file.mimetype || 'audio/webm';

        // ✅ Node.js 18+ 내장 FormData/File 사용
        const form = new FormData();
        form.append('model', process.env.STT_MODEL || 'gpt-4o-transcribe');
        form.append('file', new File([req.file.buffer], filename, { type: mimetype }));

        // ✅ Node.js 18+ 내장 fetch 사용 (OpenAI는 호환됨)
        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: form,
        });

        const ct = r.headers.get('content-type') || '';
        const raw = await r.text().catch(() => '');
        if (!r.ok) return res.status(r.status).send(raw || JSON.stringify({ error: 'upstream_error' }));
        const j = ct.includes('application/json') ? JSON.parse(raw) : { text: raw };
        return res.json({ text: j.text || '' });
    } catch (e) {
        console.error('[STT ERROR]', e);
        return res.status(500).json({ error: 'stt_failed' });
    }
});

/* ----------------------------- Serve TTS media ----------------------------- */
// (기존 TTS media 서빙 코드 ... )
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

// ====================================================================
// ▼▼▼▼▼▼ D-ID POST /talks "1크레딧 테스트" 라우트 ▼▼▼▼▼▼
// ====================================================================
app.post('/api/test-did-talk', async (req, res) => {
    if (!process.env.D_ID_API_KEY) {
        return res.status(500).json({ error: 'D_ID_API_KEY가 설정되어 있지 않습니다.' });
    }

    // ✅ 1) 여기를 네가 사용하는 아바타 이미지 URL로 교체해줘
    //    반드시 외부에서 접근 가능한 https 이미지여야 함
    const SOURCE_IMAGE_URL = 'https://illustrious-hummingbird-0af3bb.netlify.app/avatar.png';
    // ✅ 2) 기본 질문 텍스트 (진짜 OPIc 질문으로 바꿔도 됨)
    const scriptText = 'Can you tell me about your hometown and what you like about living there?';

    // ✅ 3) 인증 헤더 (GET /credits에서 쓰던 방식 그대로)
    const authHeader = `Basic ${Buffer.from(process.env.D_ID_API_KEY).toString('base64')}`;

    try {
        const body = {
            source_url: SOURCE_IMAGE_URL,
            script: {
                type: 'text',
                input: scriptText
                // 필요하면 여기서 provider (elevenlabs 등) 추가 가능
            }
        };

        const response = await fetch('https://api.d-id.com/talks', {
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const text = await response.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch {
            json = { raw: text };
        }

        console.log('D-ID /talks status:', response.status);
        console.log('D-ID /talks response body:', json);

        // 4xx/5xx는 그대로 프록시해서 프론트에서 원인 볼 수 있게
        if (!response.ok) {
            return res.status(response.status).json({
                error: 'd-id_talk_failed',
                status: response.status,
                details: json
            });
        }

        // ✅ 성공: talk id만 먼저 반환
        // (포트폴리오용 배치 스크립트에서는 여기서 id를 받아서
        //  나중에 GET /talks/{id} → result_url → mp4 다운로드 하는 구조로 확장)
        return res.json({
            message: 'D-ID /talks 요청 성공',
            talk: json
        });
    } catch (e) {
        console.error('[D-ID /talks TEST ERROR]', e);
        return res.status(500).json({ error: 'server_error', details: e.message });
    }
});


/* ------------------------------ 404/에러 핸들러 ---------------------------- */
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    console.error('[UNCAUGHT]', err);
    res.status(500).json({ error: 'server_error' });
});

/* --------------------------------- Listen --------------------------------- */
app.listen(port, () => {
    console.log(`Server on :${port}`);
    console.log('Allowed origins:', allowedOrigins.join(', '));
});