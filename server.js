import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { OpenAI } from 'openai';

const app = express();
const port = process.env.PORT || 8080;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Netlify 최종 도메인으로 교체(배포 후 실제 도메인 넣기)
const allowedOrigins = [
    'http://localhost:5173',
    'https://<your-netlify>.netlify.app',
    'https://<your-custom-domain>' // 있으면
];
app.use(cors({
    origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error('CORS blocked'), false);
    }
}));
app.use(express.json({ limit: '10mb' }));

// 헬스체크
app.get('/health', (_, res) => res.json({ ok: true }));

// GPT 답변 라우트 (텍스트 질문)
app.post('/api/ask', async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) return res.status(400).json({ error: 'prompt required' });

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'You are a helpful OPIC practice coach.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.7
        });

        const answer = completion.choices?.[0]?.message?.content ?? '';
        res.json({ answer });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'server_error' });
    }
});

// STT(선택) — 브라우저에서 FormData(audio) 업로드
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });
app.post('/api/stt', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'audio required' });

        // Whisper 사용 예 (모델/엔드포인트는 네임 확인 필요)
        const transcript = await openai.audio.transcriptions.create({
            file: new File([req.file.buffer], 'audio.webm', { type: req.file.mimetype }),
            model: 'gpt-4o-transcribe' // 또는 'whisper-1' 등, 계정에서 사용 가능한 모델로
        });

        res.json({ text: transcript.text });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'stt_error' });
    }
});

app.listen(port, () => console.log(`Server on :${port}`));
