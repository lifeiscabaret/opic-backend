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

/* ---------------------- In-memory video cache ---------------------- */
const READY_Q = [];                           // { question, url }
const MAX_Q = Number(process.env.PREFETCH_SIZE || 4);
let prefetching = false;

/* ----------------------------- Health ------------------------------ */
app.get('/', (_req, res) => res.json({ service: 'OPIC Backend', ok: true }));
app.get(['/health', '/api/health'], (_req, res) => res.json({
    ok: true,
    origins: allowedOrigins,
    routes: [
        '/api/ask',
        '/api/speak',
        '/api/queue/prefetch',
        '/api/queue/next',
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

/* ---------------------- 질문 20개 배치 프롬프트 ---------------------- */
function buildBatchPrompt(profile) {
    const { level = 'IH–AL', residence = '', role = '', recentCourse = '', topics = [] } = profile || {};
    const topicLine = (Array.isArray(topics) && topics.length)
        ? `Focus randomly on ONE of: ${topics.join(' | ')}`
        : `Focus randomly on ONE everyday topic (home/routine/hobbies/work/school/travel etc.)`;
    const profileLine = [
        `Target level: ${level}`,
        residence && `Residence: ${residence}`,
        role && `Role: ${role}`,
        recentCourse && `Recent course: ${recentCourse}`,
    ].filter(Boolean).join(' | ');

    return `
You are an OPIC examiner.
Generate 20 OPIC-style interview questions in English.
- ${topicLine}
- ${profileLine}
- Each 14–22 words, single sentence.
- Natural spoken style.
- Return ONLY a JSON array of strings. No commentary.
`.trim();
}

/* --------------------------- Prefetch APIs --------------------------- */
// 백그라운드로 큐 채움
app.post(['/api/queue/prefetch', '/queue/prefetch'], async (req, res) => {
    try {
        const want = Math.min(Number(req.body?.count || MAX_Q), MAX_Q);
        const profile = req.body?.profile || {};
        if (prefetching) return res.json({ ok: true, queued: READY_Q.length, prefetching: true });
        prefetching = true;

        (async () => {
            try {
                // (1) 질문 배치
                const r = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [
                        { role: 'system', content: 'You are an OPIC examiner.' },
                        { role: 'user', content: buildBatchPrompt(profile) },
                    ],
                    temperature: 0.3,
                });
                const raw = (r.choices?.[0]?.message?.content || '')
                    .replace(/^[\s\S]*?\[/, '[').replace(/\][\s\S]*?$/, ']');
                let qs = [];
                try { qs = JSON.parse(raw); } catch { qs = []; }
                qs = (Array.isArray(qs) ? qs : []).filter(Boolean);

                // (2) 중복 제거 후 최대 want개
                const exist = new Set(READY_Q.map(x => x.question));
                const pick = [];
                for (const q of qs) {
                    if (!exist.has(q)) pick.push(q);
                    if (pick.length >= want) break;
                }

                // (3) 동시 2개로 렌더
                const groups = pick.reduce((arr, q, i) => {
                    (arr[Math.floor(i / 2)] ||= []).push(q); return arr;
                }, []);
                for (const g of groups) {
                    await Promise.all(g.map(async (q) => {
                        try {
                            const url = await speakToVideoUrl(q, AVATAR_URL);
                            READY_Q.push({ question: q, url });
                            if (READY_Q.length > MAX_Q) READY_Q.shift();
                        } catch (e) {
                            console.warn('[prefetch render fail]', e.message);
                        }
                    }));
                }
            } catch (e) {
                console.error('[prefetch error]', e?.response?.data || e.message);
            } finally {
                prefetching = false;
            }
        })();

        res.json({ ok: true, queued: READY_Q.length });
    } catch (e) {
        console.error('[PREFETCH]', e);
        res.status(500).json({ error: 'server_error' });
    }
});

// 큐에서 즉시 꺼내오기
app.get(['/api/queue/next', '/queue/next'], (_req, res) => {
    const item = READY_Q.shift();
    if (!item) return res.status(204).end();
    res.json({ ok: true, ...item });
});

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
/* 프론트(App.js)가 치는 /api/did/webrtc/* 엔드포인트 구현 (스트리밍 즉시 발화) */

// 1) Offer: 프론트의 SDP(offer) → D-ID answer + session_id 반환
app.post(['/api/did/webrtc/offer', '/did/webrtc/offer'], async (req, res) => {
    try {
        const { sdp } = req.body || {};
        if (!sdp) return res.status(400).json({ error: 'missing_sdp' });
        if (!process.env.DID_API_KEY) return res.status(500).json({ error: 'did_api_key_missing' });

        // (a) 새 스트림 생성
        const createRes = await fetch('https://api.d-id.com/talks/streams', {
            method: 'POST',
            headers: { Authorization: didAuth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_url: AVATAR_URL }),
            agent: pickAgent,
        });
        const createTxt = await createRes.text();
        if (!createRes.ok) {
            return res.status(createRes.status).json({ error: 'did_create_stream_failed', body: createTxt.slice(0, 500) });
        }
        const { id } = JSON.parse(createTxt) || {};
        if (!id) return res.status(502).json({ error: 'no_stream_id', body: createTxt.slice(0, 500) });

        // (b) SDP 교환(offer -> answer)
        const sdpRes = await fetch(`https://api.d-id.com/talks/streams/${id}/sdp`, {
            method: 'POST',
            headers: { Authorization: didAuth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sdp }),
            agent: pickAgent,
        });
        const sdpTxt = await sdpRes.text();
        if (!sdpRes.ok) {
            return res.status(sdpRes.status).json({ error: 'did_sdp_failed', body: sdpTxt.slice(0, 500) });
        }
        const { answer } = JSON.parse(sdpTxt) || {};
        if (!answer) return res.status(502).json({ error: 'no_answer', body: sdpTxt.slice(0, 500) });

        return res.json({ answer, session_id: id, imageUrl: AVATAR_URL, voice: DEFAULT_VOICE });
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
