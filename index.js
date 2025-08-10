const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { OpenAI } = require("openai");  // ✅ 수정된 부분

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({             // ✅ 수정된 부분
    apiKey: process.env.OPENAI_API_KEY,
});

app.post("/ask", async (req, res) => {
    try {
        const { question } = req.body;

        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: question }],
        });

        res.json({ answer: completion.choices[0].message.content });
    } catch (err) {
        console.error("GPT 호출 오류:", err);
        res.status(500).json({ error: "GPT 호출 실패" });
    }
});

const PORT = 5001;
app.listen(PORT, () => console.log(`✅ 백엔드 서버 시작됨: http://localhost:${PORT}`));