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
            '/review', '/api/review',
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

/* ----------------------------- OPIc Review Prompt ----------------------------- */
function buildReviewPrompt({ questionText, answerText, targetLevel }) {
    return `
You are a professional OPIc speaking test evaluator.

Your task:
- Evaluate the user's spoken answer (already transcribed into text).
- Target OPIc level: ${targetLevel} (e.g., IM1, IM2, IH, AL)
- Question: """${questionText}"""
- User answer: """${answerText}"""

Evaluation criteria:
1. Fluency (natural flow, pauses, hesitation)
2. Grammar (accuracy, range)
3. Vocabulary (range, appropriateness, topic relevance)
4. Task Achievement (did they fully and clearly answer the question?)

Output format:
You MUST return ONLY a single JSON object, with NO extra text.

The JSON structure MUST be:

{
  "fluency": "1~2 sentence feedback",
  "grammar": "1~2 sentence feedback",
  "vocab": "1~2 sentence feedback",
  "taskAchievement": "1~3 sentence feedback",
  "score": 1-5,
  "overallFeedback": "3~5 sentence overall feedback",
  "recommendedLevel": "IM1" | "IM2" | "IH" | "AL"
}

Constraints:
- "score" must be an integer between 1 and 5.
- "recommendedLevel" must be exactly one of "IM1", "IM2", "IH", "AL".
- Do NOT include any explanation outside the JSON.
`;
}

/* ------------------------------- REVIEW (OPIc Answer Evaluation) ------------------------------- */
app.post(['/review', '/api/review'], async (req, res) => {
    try {
        const {
            questionId,
            questionText,
            answerText,
            targetLevel, // "IM1" | "IM2" | "IH" | "AL"
        } = req.body || {};

        if (!questionId || !questionText || !answerText || !targetLevel) {
            return res.status(400).json({
                error: 'missing_fields',
                message: 'questionId, questionText, answerText, targetLevel는 모두 필수입니다.',
            });
        }

        const prompt = buildReviewPrompt({
            questionText: questionText.toString(),
            answerText: answerText.toString(),
            targetLevel: targetLevel.toString(),
        });

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: 'You are a strict but kind OPIc speaking test evaluator.',
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            temperature: 0.3,
            response_format: { type: 'json_object' }, // JSON 강제
        });

        let rawContent = completion.choices?.[0]?.message?.content?.trim() || '';

        // 혹시라도 ```json ... ``` 형태로 올 경우 대비한 방어 로직
        if (rawContent.startsWith('```')) {
            rawContent = rawContent
                .replace(/^```json/i, '')
                .replace(/^```/, '')
                .replace(/```$/, '')
                .trim();
        }

        let review;
        try {
            review = JSON.parse(rawContent);
        } catch (e) {
            console.error('[REVIEW JSON PARSE ERROR] rawContent =', rawContent);
            return res.status(500).json({
                error: 'invalid_review_json',
                rawContent,
            });
        }

        // 최소 검증 (score / overallFeedback 정도)
        if (typeof review.score !== 'number' || !review.overallFeedback) {
            console.warn('[REVIEW SHAPE WARNING] review =', review);
        }

        return res.json({
            questionId,
            targetLevel,
            ...review,
        });
    } catch (e) {
        console.error('[REVIEW ERROR]', e);
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
        const model = process.env.TTS_MODEL || 'gpt-4o-mini-tts'; // 최신 저비용 TTS 권장
        const VOICES = ['nova', 'shimmer', 'echo', 'onyx', 'fable', 'alloy', 'ash', 'sage', 'coral'];
        const requested = (voice || process.env.TTS_VOICE || 'sage').toLowerCase();
        const voiceId = VOICES.includes(requested) ? requested : 'sage';
        const format = 'mp3'; // mp3가 사파리/윈도우 모두 호환 잘 됨

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
