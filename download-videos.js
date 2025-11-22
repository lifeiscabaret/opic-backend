// download-videos.js
import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';

if (!process.env.D_ID_API_KEY) {
    console.error('❌ D_ID_API_KEY is missing in .env');
    process.exit(1);
}

const authHeader =
    'Basic ' + Buffer.from(process.env.D_ID_API_KEY).toString('base64');

// talks-result.json 읽기
const resultsPath = new URL('./talks-result.json', import.meta.url);
if (!fs.existsSync(resultsPath)) {
    console.error('❌ talks-result.json not found. 먼저 create-videos.js를 실행해서 결과를 만들어줘!');
    process.exit(1);
}

const results = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));

// videos 폴더 생성
const videosDir = new URL('./videos/', import.meta.url);
if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadFile(url, outPath) {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Download failed with status ${res.status}`);
    }
    const arrayBuf = await res.arrayBuffer();
    fs.writeFileSync(outPath, Buffer.from(arrayBuf));
}

async function main() {
    console.log(`📄 Loaded ${results.length} records from talks-result.json`);

    let downloaded = 0;

    for (const r of results) {
        // status가 ok이고 talkId가 있어야 의미 있음
        if (!r || r.status !== 'ok' || !r.talkId) {
            console.log(`↩️ Skip ${r?.id} (status=${r?.status}, talkId=${r?.talkId})`);
            continue;
        }

        const fileName = `${r.id}.mp4`;
        const outPath = new URL(`./videos/${fileName}`, import.meta.url);

        // 이미 파일이 있으면 스킵 (중복 다운로드 방지)
        if (fs.existsSync(outPath)) {
            console.log(`📦 Already exists, skip: ${fileName}`);
            continue;
        }

        console.log(`\n➡️ Checking talk ${r.id} (talkId=${r.talkId})`);

        // 1) talk 상태 조회
        const talkRes = await fetch(`https://api.d-id.com/talks/${r.talkId}`, {
            method: 'GET',
            headers: { Authorization: authHeader },
        });

        const raw = await talkRes.text();
        let talkJson;
        try {
            talkJson = JSON.parse(raw);
        } catch {
            talkJson = { raw };
        }

        if (!talkRes.ok) {
            console.error(`❌ Failed to get talk ${r.id} (status ${talkRes.status})`, talkJson);
            continue;
        }

        const status = talkJson.status;
        const resultUrl = talkJson.result_url;

        console.log(`   talk status = ${status}`);

        if (!resultUrl) {
            console.log(`⚠️ ${r.id}: 아직 result_url이 없네. 나중에 다시 시도해줘.`);
            continue;
        }

        console.log(`   🎥 result_url: ${resultUrl}`);
        console.log(`   ⬇️ Downloading to videos/${fileName} ...`);

        try {
            await downloadFile(resultUrl, outPath);
            console.log(`   ✅ Downloaded ${fileName}`);
            downloaded += 1;
        } catch (e) {
            console.error(`   💥 Download failed for ${r.id}`, e);
        }

        // D-ID 서버에 너무 부담 안 주게 약간 딜레이
        await sleep(1000);
    }

    console.log(`\n🎉 Done! Newly downloaded: ${downloaded} file(s).`);
    console.log('   Check the videos/ folder!');
}

main().catch((e) => {
    console.error('💥 Unhandled error in download-videos.js', e);
    process.exit(1);
});
