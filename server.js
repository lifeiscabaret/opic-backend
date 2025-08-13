// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { OpenAI } from 'openai';

const app = express();
const port = process.env.PORT || 8080;

/** ✅ CORS
 * - Render 환경변수 ALLOWED_ORIGINS 에 콤마(,)로 여러 도메인 지정 가능.
 * - 미지정 시 기본값으로 Netlify 프로덕션 도메인과 localhost:3000 허용.
 */
const DEFAULT_ORIGINS = [
    'https://illustrious-hummingbird-0af3bb.netlify.app', // ← 네 도메인
    'http://localhost:3000',
];

const allowedOrigins = (process.env.ALLOWED_ORIGINS && process.env.ALLOWED_ORIGINS.trim().length > 0)
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_ORIGINS;

app.use(cors({
    origin(origin, cb) {
        // 서버 내부/헬스체크 등 Origin 없는 요청 허용
        if (!origin) return cb(null, true);
        const ok = allowedOrigins.includes(origin);
        return ok ? cb(null, true) : cb(new Error(`Not allowed by CORS: ${origin}`), false);
    },
    credentials: false, // 쿠키 안 쓰면 false
}));

app.use(express.json({ limit: '10mb' }));

// 업로드(메모리 저장)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 헬스체크
app.get('/health', (_req, res) => res.json({ ok: true, origins: allowedOrigins }));

// 프론트가 부르는 엔드포인트 (POST /ask { question, prompt? })
app.post('/ask', async (req, res) => {
    try {
        const { question, prompt } = req.body || {};
        const content = prompt ?? question;
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
        res.json({ answer });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'server_error' });
    }
});

// (선택) STT 라우트는 나중에 추가
// app.post('/stt', upload.single('audio'), ...)

app.listen(port, () => console.log(`Server on :${port}`));
