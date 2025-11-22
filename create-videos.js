// create-videos.js
import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';

const SOURCE_IMAGE_URL = 'https://illustrious-hummingbird-0af3bb.netlify.app/avatar.png';

// ✅ 이번 실행에서 "새로" 만들 최대 개수 (처음엔 3~5 정도로 두자)
const MAX_NEW_TALKS_PER_RUN = 5;

if (!process.env.D_ID_API_KEY) {
    console.error('❌ D_ID_API_KEY is missing in .env');
    process.exit(1);
}

const authHeader =
    'Basic ' + Buffer.from(process.env.D_ID_API_KEY).toString('base64');

// 질문 리스트 로드
const questionsPath = new URL('./questions.json', import.meta.url);
const questions = JSON.parse(fs.readFileSync(questionsPath, 'utf-8'));

// 이미 만들어진 결과(talks-result.json) 있으면 불러오기
const resultsPath = new URL('./talks-result.json', import.meta.url);
let existingResults = [];
if (fs.existsSync(resultsPath)) {
    existingResults = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
}

const existingMap = new Map();
for (const r of existingResults) {
    if (r && r.id) {
        existingMap.set(r.id, r);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    console.log(`📝 Loaded ${questions.length} questions`);
    console.log(`📄 Loaded ${existingResults.length} existing results`);

    const newResults = [...existingResults]; // 여기에 덧붙여 가기
    let createdCount = 0;

    for (const q of questions) {
        // 1) 이미 성공한 질문이면 스킵
        const prev = existingMap.get(q.id);
        if (prev && prev.status === 'ok') {
            console.log(`↩️ Skip ${q.id} (already created: talkId=${prev.talkId})`);
            continue;
        }

        // 2) 이번 실행에서 허용한 개수 초과 시 더 이상 생성 안 함
        if (createdCount >= MAX_NEW_TALKS_PER_RUN) {
            console.log(`⏹ Reached MAX_NEW_TALKS_PER_RUN=${MAX_NEW_TALKS_PER_RUN}, stop here.`);
            break;
        }

        console.log(`\n➡️ Creating talk for ${q.id} [${q.topic}]`);
        const body = {
            source_url: SOURCE_IMAGE_URL,
            script: {
                type: 'text',
                input: q.text,
            },
        };

        try {
            const res = await fetch('https://api.d-id.com/talks', {
                method: 'POST',
                headers: {
                    Authorization: authHeader,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });

            const raw = await res.text();
            let json;
            try {
                json = JSON.parse(raw);
            } catch {
                json = { raw };
            }

            if (!res.ok) {
                console.error(`❌ Failed for ${q.id} (status ${res.status})`, json);
                const record = {
                    id: q.id,
                    status: 'error',
                    httpStatus: res.status,
                    response: json,
                };
                existingMap.set(q.id, record);
                newResults.push(record);
            } else {
                console.log(`✅ Success for ${q.id} → talk id = ${json.id}`);
                const record = {
                    id: q.id,
                    status: 'ok',
                    talkId: json.id,
                };
                existingMap.set(q.id, record);
                newResults.push(record);
                createdCount += 1;
            }
        } catch (err) {
            console.error(`💥 Exception for ${q.id}`, err);
            const record = {
                id: q.id,
                status: 'exception',
                error: String(err.message || err),
            };
            existingMap.set(q.id, record);
            newResults.push(record);
        }

        await sleep(1500);
    }

    fs.writeFileSync(resultsPath, JSON.stringify(newResults, null, 2), 'utf-8');
    console.log(`\n🎉 Done! created this run: ${createdCount}, total records: ${newResults.length}`);
    console.log('   Saved to talks-result.json');
}

main().catch((e) => {
    console.error('💥 Unhandled error in main()', e);
    process.exit(1);
});
