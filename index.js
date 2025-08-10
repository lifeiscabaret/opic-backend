const express = require("express");
const cors = require("cors");
require("dotenv").config();

// ✅ CommonJS에서는 이렇게 임포트
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ OpenAI 클라이언트
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// ✅ 헬스/루트 라우트
app.get("/", (req, res) => res.send("OPIc API server is running."));
app.get("/health", (req, res) => res.json({ ok: true }));

// API
app.post("/ask", async (req, res) => {
    try {
        const { question } = req.body;
        if (!question) return res.status(400).json({ error: "question required" });

        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: question }],
        });

        res.json({ answer: completion.choices?.[0]?.message?.content ?? "" });
    } catch (err) {
        console.error("GPT 호출 오류:", err);
        res.status(500).json({ error: "GPT 호출 실패" });
    }
});

// ✅ Render에서 필수: 환경변수 포트 사용
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`✅ 백엔드 서버 시작됨: :${PORT}`));
