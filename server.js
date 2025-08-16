import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

/* ---------------- 경로 유틸 ---------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------------- 기본 설정 ---------------- */
const app = express();
const PORT = process.env.PORT || 5000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------------- CORS ---------------- */
const allowedOrigins = [
    "https://illustrious-hummingbird-0af3bb.netlify.app",
    "http://localhost:3000",
];
app.use(
    cors({
        origin: allowedOrigins,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type"],
    })
);

/* ---------------- 바디 파서 ---------------- */
app.use(express.json({ limit: "10mb" }));

/* ---------------- 업로드 ---------------- */
const upload = multer({ dest: "uploads/" });

/* ---------------- 라우트 ---------------- */

// health check
app.get("/health", (req, res) => {
    res.json({
        ok: true,
        origins: allowedOrigins,
        routes: ["/ask", "/tts-eleven", "/stt", "/media/tts/:id"],
    });
});

// GPT 질문/답변
app.post("/ask", async (req, res) => {
    try {
        const { question } = req.body;
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: question }],
        });
        const answer = completion.choices[0].message.content;
        res.json({ answer });
    } catch (err) {
        console.error("ask error:", err);
        res.status(500).json({ error: "ask_failed" });
    }
});

// OpenAI TTS
app.post("/tts-eleven", async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: "no_text" });

        const speechFile = path.join(__dirname, "tmp", `tts_${Date.now()}.mp3`);
        const result = await openai.audio.speech.create({
            model: "gpt-4o-mini-tts",
            voice: "alloy", // 기본 여성에 가까운 중성 톤
            input: text,
        });

        const buffer = Buffer.from(await result.arrayBuffer());
        fs.writeFileSync(speechFile, buffer);

        const fileName = path.basename(speechFile);
        res.json({ audioUrl: `/media/tts/${fileName}` });
    } catch (err) {
        console.error("tts error:", err);
        res.status(500).json({ error: "tts_failed" });
    }
});

// STT
app.post("/stt", upload.single("file"), async (req, res) => {
    try {
        const audioPath = req.file.path;
        const transcript = await openai.audio.transcriptions.create({
            model: "gpt-4o-mini-transcribe",
            file: fs.createReadStream(audioPath),
        });
        fs.unlinkSync(audioPath);
        res.json({ text: transcript.text });
    } catch (err) {
        console.error("stt error:", err);
        res.status(500).json({ error: "stt_failed" });
    }
});

// mp3 서빙
app.use("/media/tts", express.static(path.join(__dirname, "tmp")));

/* ---------------- 서버 실행 ---------------- */
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
