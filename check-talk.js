// check-talk.js
import 'dotenv/config';
import fetch from 'node-fetch';

if (!process.env.D_ID_API_KEY) {
    console.error('❌ D_ID_API_KEY is missing in .env');
    process.exit(1);
}

// 터미널 인자로 talkId 받기 (없으면 에러)
const talkId = process.argv[2];
if (!talkId) {
    console.error('Usage: node check-talk.js <talkId>');
    process.exit(1);
}

const authHeader =
    'Basic ' + Buffer.from(process.env.D_ID_API_KEY).toString('base64');

async function main() {
    const url = `https://api.d-id.com/talks/${talkId}`;
    console.log('📡 GET', url);

    const res = await fetch(url, {
        method: 'GET',
        headers: {
            Authorization: authHeader,
        },
    });

    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = { raw: text };
    }

    console.log('HTTP status:', res.status);
    console.log('Response JSON:', json);

    if (json.result_url) {
        console.log('\n🎥 Video result_url:');
        console.log(json.result_url);
    } else {
        console.log('\n⚠️ 아직 result_url이 없네. status 필드를 확인해봐 (created / in_progress / done 등).');
    }
}

main().catch((e) => {
    console.error('💥 Error in check-talk.js', e);
    process.exit(1);
});
