// server.js
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
        if (!origin) return cb(null, true); // 헬스체크 등
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

// ✅ D-ID 인증 헤더 (Basic: base64("<API_KEY>:"))
const didAuth =
    'Basic ' + Buffer.from(String(process.env.DID_API_KEY || '') + ':').toString('base64');

/* ----------------------------- In-Memory Media ----------------------------- */
// 프로세스 리스타트 시 사라지는 간단 캐시
const mediaStore = new Map(); // id -> { buf, mime, ts }
const MEDIA_TTL_MS = Number(process.env.MEDIA_TTL_MS || 1000 * 60 * 60); // 1h

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
// 주기 청소
setInterval(() => {
    const now = Date.now();
    for (const [id, v] of mediaStore) {
        if (now - v.ts > MEDIA_TTL_MS) mediaStore.delete(id);
    }
}, 60_000);

/* --------------------------------- Health --------------------------------- */
app.get('/', (_req, res) => res.json({ service: 'OPIC Backend', ok: true }));
app.get(['/health', '/api/health'], (_req, res) =>
    res.json({
        ok: true,
        origins: allowedOrigins,
        routes: [
            '/ask', '/api/ask',
            '/speak', '/api/speak',
            '/tts', '/api/tts',
            '/tts-eleven', '/api/tts-eleven',
            '/stt', '/api/stt',                 // ✅ 추가됨
            '/media/tts/:id'
        ],
    })
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
// 텍스트+이미지 → D-ID 립싱크 영상 URL
app.post(['/speak', '/api/speak'], async (req, res) => {
    try {
        const { text, imageUrl, voice = 'en-US-JennyNeural' } = req.body || {};
        if (!text || !imageUrl) return res.status(400).json({ error: 'text and imageUrl required' });
        if (text.trim().length < 3) return res.status(400).json({ error: 'text_too_short', min: 3 });
        if (!process.env.DID_API_KEY) return res.status(500).json({ error: 'did_api_key_missing' });

        // 1) 생성 요청
        const createdRes = await fetch('https://api.d-id.com/talks', {
            method: 'POST',
            headers: {
                Authorization: didAuth,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({
                source_url: imageUrl,
                script: {
                    type: 'text',
                    input: text,
                    provider: { type: 'microsoft', voice_id: voice },
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
        if (!created?.id) return res.status(502).json({ error: 'create_failed', detail: created });

        // 2) 상태 폴링
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

/* ------------------------ OpenAI TTS (백업 라인) --------------------------- */
// ✅ 보이스 안전화: MS/Azure 스타일이 오면 alloy로 강제 매핑
const normalizeOpenAIVoice = (v) => {
    if (!v) return null;
    if (/jenny|neural|en-?us/i.test(v)) return 'alloy'; // 방어 매핑
    return v;
};

app.post(['/tts', '/api/tts'], async (req, res) => {
    try {
        const { text, voice } = req.body || {};
        const input = (text || '').toString().trim();
        if (!input) return res.status(400).json({ error: 'text required' });

        const model = process.env.TTS_MODEL || 'tts-1';
        const voiceId = normalizeOpenAIVoice(voice) || process.env.TTS_VOICE || 'alloy';
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
        console.error('[TTS ERROR]', e);
        return res.status(500).json({ error: 'server_error' });
    }
});

/* --------------------------- ElevenLabs TTS (우선) ------------------------- */
// 모바일(iOS) 안정화를 위한 우선 경로
app.post(['/tts-eleven', '/api/tts-eleven'], async (req, res) => {
    try {
        const { text, voice = 'Rachel' } = req.body || {};
        const input = (text || '').toString().trim();
        if (!input) return res.status(400).json({ error: 'text required' });
        if (!process.env.ELEVEN_API_KEY) return res.status(500).json({ error: 'eleven_api_key_missing' });

        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
            method: 'POST',
            headers: {
                'xi-api-key': process.env.ELEVEN_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg',
            },
            body: JSON.stringify({ text: input }),
        });

        if (!r.ok) {
            const t = await r.text();
            return res.status(r.status).json({ error: 'eleven_failed', body: t.slice(0, 800) });
        }

        const buf = Buffer.from(await r.arrayBuffer());
        const id = putMedia(buf, 'audio/mpeg');
        const audioUrl = `${req.protocol}://${req.get('host')}/media/tts/${id}`;
        return res.json({ audioUrl, provider: 'elevenlabs', voice });
    } catch (e) {
        console.error('[ELEVEN TTS ERROR]', e);
        return res.status(500).json({ error: 'server_error' });
    }
});

/* ------------------------------- STT 프록시 추가 --------------------------- */
/** 
 * 프론트에서 FormData('file'=<Blob>)로 업로드 → 백엔드가 OpenAI Whisper에 전달
 * - 프론트 키 노출 없음
 * - 업로드 필드명: "file" (App.js와 일치)
 */
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

        // Node18+ (undici) 전역 FormData / File / Blob 사용
        const form = new FormData();
        form.append('model', 'whisper-1');
        form.append('file', new File([req.file.buffer], filename, { type: mimetype }));
        // 옵션 예시:
        // form.append('temperature', '0');
        // form.append('language', 'en');

        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: form,
        });

        if (!r.ok) {
            const errTxt = await r.text().catch(() => '');
            return res.status(r.status).send(errTxt);
        }
        const j = await r.json();
        return res.json({ text: j.text || '' });
    } catch (e) {
        console.error('[STT ERROR]', e);
        return res.status(500).json({ error: 'stt_failed' });
    }
});

/* ----------------------------- Serve TTS media ----------------------------- */
// iOS 호환을 위해 Range/HEAD 지원
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
