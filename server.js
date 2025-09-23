// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { OpenAI } from 'openai';
import fetch from 'node-fetch';
import http from 'http';
import https from 'https';

const app = express();
const port = process.env.PORT || 8080;

/* ---------------- Keep-Alive agents (왕복 지연 ↓) ---------------- */
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

// node-fetch의 agent 콜백은 URL 객체/문자열이 들어올 수 있음 → 안전한 선택자
const pickAgent = (u) => {
    try {
        const proto =
            typeof u === 'string' ? new URL(u).protocol : (u?.protocol || 'https:');
        return proto === 'http:' ? httpAgent : httpsAgent;
    } catch {
        return httpsAgent;
    }
};

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
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
});

/* ----------------------------- Clients ----------------------------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ----------------------------- Utils ------------------------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const didAuth = 'Basic ' + Buffer.from(String(process.env.DID_API_KEY || '') + ':').toString('base64');
const AVATAR_URL = process.env.DEFAULT_AVATAR_IMAGE_URL; // D-ID 이미지 URL
const DEFAULT_VOICE = process.env.DID_VOICE_ID || process.env.DID_TTS_VOICE || 'en-US-JennyNeural';

/* ----------------------------- Health ------------------------------ */
app.get('/', (_req, res) => res.json({ service: 'OPIC Backend', ok: true }));
app.get(['/health', '/api/health'], (_req, res) => res.json({
    ok: true,
    origins: allowedOrigins,
    routes: [
        '/api/ask',
        '/api/speak',
        '/api/did/webrtc/offer',
        '/api/did/webrtc/ice',
        '/api/did/webrtc/talk',
    ],
}));

/* ------------------------------- ASK ------------------------------- */
app.post(['/ask', '/api/ask'], async (req, res) => {
    try {
        const { question, prompt } = req.body || {};
        const content = (prompt ?? question)?.toString().trim();
        if (!content) return res.status(400).json({ error: 'question required' });

        const r = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are an OPIC examiner.' },
                { role: 'user', content }
            ],
            temperature: 0.5,
        });
        const answer = r.choices?.[0]?.message?.content ?? '';
        res.json({ answer });
    } catch (e) {
        console.error('[ASK]', e?.response?.data || e.message);
        res.status(500).json({ error: 'server_error' });
    }
});

/* ------------------- D-ID: text → mp4 (빠른 설정) ------------------- */
async function speakToVideoUrl(
    text,
    imageUrl = AVATAR_URL,
    voice = DEFAULT_VOICE
) {
    if (!process.env.DID_API_KEY) throw new Error('did_api_key_missing');
    if (!imageUrl) throw new Error('avatar_image_missing');

    // 1) 생성 (stitch:false → 생성속도 ↑)
    const createdRes = await fetch('https://api.d-id.com/talks', {
        method: 'POST',
        headers: { Authorization: didAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            source_url: imageUrl,
            script: {
                type: 'text',
                input: text,
                provider: { type: process.env.DID_TTS_PROVIDER || 'microsoft', voice_id: voice },
            },
            config: { stitch: false, result_format: 'mp4' },
        }),
        agent: pickAgent,
    });
    const createdText = await createdRes.text();
    if (!createdRes.ok) throw new Error(`[DID create ${createdRes.status}] ${createdText.slice(0, 200)}`);
    const created = JSON.parse(createdText);
    if (!created?.id) throw new Error('did_create_no_id');

    // 2) 폴링 (최대 45초 / 0.9초 간격)
    const start = Date.now();
    while (Date.now() - start < 45000) {
        await sleep(900);
        const pollRes = await fetch(`https://api.d-id.com/talks/${created.id}`, {
            headers: { Authorization: didAuth },
            agent: pickAgent,
        });
        const pollText = await pollRes.text();
        if (!pollRes.ok) throw new Error(`[DID poll ${pollRes.status}] ${pollText.slice(0, 200)}`);
        const data = JSON.parse(pollText);
        if (data?.result_url) return data.result_url;
        if (data?.status === 'error') throw new Error(`did_render_error: ${JSON.stringify(data)}`);
    }
    throw new Error('did_timeout');
}

/* --------------------- 단건 생성(큐 비었을 때 폴백) --------------------- */
app.post(['/speak', '/api/speak'], async (req, res) => {
    try {
        const {
            text,
            imageUrl = AVATAR_URL,
            voice = DEFAULT_VOICE
        } = req.body || {};
        if (!text || !imageUrl) return res.status(400).json({ error: 'text and imageUrl required' });
        const url = await speakToVideoUrl(text, imageUrl, voice);
        res.json({ videoUrl: url });
    } catch (e) {
        console.error('[SPEAK]', e.message);
        res.status(500).json({ error: 'server_error', detail: e.message });
    }
});

/* ===================== D-ID WebRTC proxy routes ===================== */

// 1) Offer: 프론트의 SDP(offer) → D-ID answer + session_id 반환 (최종 수정본)
app.post(['/api/did/webrtc/offer', '/did/webrtc/offer'], async (req, res) => {
    try {
        const { sdp } = req.body || {};
        if (!sdp) return res.status(400).json({ error: 'missing_sdp' });
        if (!process.env.DID_API_KEY) return res.status(500).json({ error: 'did_api_key_missing' });

        const streamResponse = await fetch('https://api.d-id.com/talks/streams', {
            method: 'POST',
            headers: { Authorization: didAuth, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source_url: AVATAR_URL,
                sdp: sdp,
            }),
            agent: pickAgent,
        });

        const streamText = await streamResponse.text();
        if (!streamResponse.ok) {
            return res.status(streamResponse.status).json({ error: 'did_create_stream_failed', body: streamText.slice(0, 500) });
        }

        const streamData = JSON.parse(streamText);
        const sessionId = streamData.id;
        const sdpAnswer = streamData.offer.sdp; // ✅ 수정된 부분

        if (!sessionId || !sdpAnswer) {
            return res.status(502).json({ error: 'did_response_missing_info', body: streamText.slice(0, 500) });
        }

        return res.json({ answer: sdpAnswer, session_id: sessionId });

    } catch (err) {
        console.error('[DID/OFFER]', err);
        res.status(500).json({ error: 'server_error' });
    }
});

// 2) ICE: 브라우저 ICE 후보 전달
app.post(['/api/did/webrtc/ice', '/did/webrtc/ice'], async (req, res) => {
    try {
        const { session_id, candidate } = req.body || {};
        if (!session_id) return res.status(400).json({ error: 'missing_session_id' });

        const r = await fetch(`https://api.d-id.com/talks/streams/${session_id}/ice`, {
            method: 'POST',
            headers: { Authorization: didAuth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ candidate: candidate ?? null }),
            agent: pickAgent,
        });
        const t = await r.text();
        if (!r.ok) return res.status(r.status).json({ error: 'did_ice_failed', body: t.slice(0, 500) });

        res.json({ ok: true });
    } catch (err) {
        console.error('[DID/ICE]', err);
        res.status(500).json({ error: 'server_error' });
    }
});

// 3) Talk: 세션에 텍스트를 실시간으로 읽히기
app.post(['/api/did/webrtc/talk', '/did/webrtc/talk'], async (req, res) => {
    try {
        const { session_id, text, imageUrl, voice } = req.body || {};
        if (!session_id || !text) return res.status(400).json({ error: 'missing_params' });

        const payload = {
            script: { type: 'text', input: text, provider: { type: 'microsoft', voice_id: voice || DEFAULT_VOICE } },
            source_url: imageUrl || AVATAR_URL,
            config: { stitch: false },
        };

        const r = await fetch(`https://api.d-id.com/talks/streams/${session_id}`, {
            method: 'POST',
            headers: { Authorization: didAuth, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            agent: pickAgent,
        });
        const tx = await r.text();
        if (!r.ok) return res.status(r.status).json({ error: 'did_talk_failed', body: tx.slice(0, 500) });

        res.json({ ok: true });
    } catch (err) {
        console.error('[DID/TALK]', err);
        res.status(500).json({ error: 'server_error' });
    }
});

/* ----------------------------- 404 & Error ----------------------------- */
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    console.error('[UNCAUGHT]', err);
    res.status(500).json({ error: 'server_error' });
});

/* ------------------------------- Listen ------------------------------- */
app.listen(port, () => {
    console.log(`Server on :${port}`);
    console.log('Allowed origins:', allowedOrigins.join(', '));
});