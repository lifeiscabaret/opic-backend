// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { OpenAI } from 'openai';
import http from 'http';
import https from 'https';

const app = express();
const port = process.env.PORT || 8080;

/* ---------------- Keep-Alive agents (왕복 지연 ↓) ---------------- */
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

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

// ✅ 파일 업로드를 처리하기 위한 multer 설정
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB 파일 크기 제한
});

/* ----------------------------- Clients ----------------------------- */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ----------------------------- Health ------------------------------ */
app.get('/', (_req, res) => res.json({ service: 'OPIC Backend', ok: true }));
app.get(['/health', '/api/health'], (_req, res) => res.json({
    ok: true,
    origins: allowedOrigins,
    routes: [
        '/api/ask',
        '/api/tts',
        '/api/transcribe', // ✅ 새로운 음성인식 엔드포인트
    ],
}));

/* ------------------------------- ASK (GPT 답변) ------------------------------- */
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


/* ---------------------------- TTS (OpenAI 음성 생성) -------------------------------- */
app.post(['/tts', '/api/tts'], async (req, res) => {
    try {
        const { text, voice = 'alloy' } = req.body || {};
        if (!text) return res.status(400).json({ error: 'text required' });

        const audioStream = await openai.audio.speech.create({
            model: 'tts-1',
            voice: voice,
            input: text,
            response_format: 'mp3',
        });

        res.setHeader('Content-Type', 'audio/mpeg');
        audioStream.body.pipe(res);

    } catch (e) {
        console.error('[TTS]', e?.response?.data || e.message);
        res.status(500).json({ error: 'tts_server_error' });
    }
});


/* ------------------------- TRANSCRIBE (Whisper 음성인식) -------------------------- */
// ✅ 여기가 사용자의 녹음 파일을 텍스트로 변환하는 새로운 핵심 기능입니다.
app.post(['/transcribe', '/api/transcribe'], upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No audio file uploaded.' });
        }

        // Whisper API는 파일 이름과 타입 정보가 필요합니다.
        // req.file.buffer를 가상의 파일처럼 만들어 전달합니다.
        const audioFile = {
            name: req.file.originalname || 'audio.webm',
            type: req.file.mimetype,
        };

        const transcription = await openai.audio.transcriptions.create({
            model: 'whisper-1',
            file: new File([req.file.buffer], audioFile.name, { type: audioFile.type }),
            language: 'en', // 영어(en)로 인식하도록 설정
        });

        res.json({ text: transcription.text });

    } catch (e) {
        console.error('[TRANSCRIBE]', e?.response?.data || e.message);
        res.status(500).json({ error: 'transcribe_server_error' });
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