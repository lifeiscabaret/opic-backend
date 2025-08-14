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
// 허용 도메인: 환경변수 ALLOWED_ORIGINS가 있으면 우선, 없으면 기본값 사용
const DEFAULT_ORIGINS = [
    'https://illustrious-hummingbird-0af3bb.netlify.app',
    'http://localhost:3000',
];

const allowedOrigins = (process.env.ALLOWED_ORIGINS && process.env.ALLOWED_ORIGINS.trim().length > 0)
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_ORIGINS;

app.use(cors({
    origin(origin, cb) {
        // 서버 내부 호출/헬스체크 등 Origin 없는 요청 허용
        if (!origin) return cb(null, true);
        const ok = allowedOrigins.includes(origin);
        return ok ? cb(null, true) : cb(new Error(`Not allowed by CORS: ${origin}`), false);
    },
    credentials: false,
}));

// 모든 경로의 프리플라이트 허용
app.options('*', cors());

/* ---------------------------- Body & Upload Limit --------------------------- */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

// 업로드(메모리 저장) — 필요 시 STT 등에서 사용
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
});

/* --------------------------------- Clients -------------------------------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* --------------------------------- Utils ---------------------------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* --------------------------------- Health --------------------------------- */
// 루트: HTML 404 방지용 JSON 안내
app.get('/', (_req, res) => res.json({ service: 'OPIC Backend', ok: true }));

// 헬스엔드포인트 (/health, /api/health 모두 지원)
app.get(['/health', '/api/health'], (_req, res) =>
    res.json({ ok: true, origins: allowedOrigins, routes: ['/ask', '/api/ask', '/speak', '/api/speak'] })
);

/* ----------------------------------- ASK ---------------------------------- */
// 프론트가 부르는 엔드포인트 (POST /ask 또는 /api/ask)
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
        if (!process.env.DID_API_KEY) {
            return res.status(500).json({ error: 'did_api_key_missing' });
        }

        // 1) 생성 요청
        const createdRes = await fetch('https://api.d-id.com/talks', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.DID_API_KEY}`,
                'Content-Type': 'application/json',
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

        // D‑ID가 HTML을 줄 때를 대비해 항상 text 먼저 읽기
        const createdText = await createdRes.text();
        if (!createdRes.ok) {
            return res
                .status(createdRes.status)
                .json({ error: 'did_create_failed', body: createdText.slice(0, 500) });
        }
        let created;
        try { created = JSON.parse(createdText); } catch {
            return res.status(502).json({ error: 'did_create_not_json', body: createdText.slice(0, 500) });
        }
        if (!created?.id) {
            return res.status(502).json({ error: 'create_failed', detail: created });
        }

        // 2) 상태 폴링 (최대 ~30초)
        let videoUrl = null;
        for (let i = 0; i < 24; i++) {
            await sleep(1250);
            const pollRes = await fetch(`https://api.d-id.com/talks/${created.id}`, {
                headers: { Authorization: `Bearer ${process.env.DID_API_KEY}` },
            });
            const pollText = await pollRes.text();
            if (!pollRes.ok) {
                return res
                    .status(pollRes.status)
                    .json({ error: 'did_poll_failed', body: pollText.slice(0, 500) });
            }
            let data;
            try { data = JSON.parse(pollText); } catch {
                return res.status(502).json({ error: 'did_poll_not_json', body: pollText.slice(0, 500) });
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
// 예시: 브라우저 업로드 파일 받아 Whisper로 처리할 때
// app.post(['/stt','/api/stt'], upload.single('audio'), async (req, res) => { ... });

/* -------------------------- 404/에러 핸들러(JSON) -------------------------- */
// 존재하지 않는 경로는 HTML 대신 JSON 404
app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
});

// 최종 에러 핸들러
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
