// Athena local dev harness:
// - intercepts api.telegram.org calls (captures payloads, returns canned OK)
// - boots server/index.js against a local Postgres
// - exposes POST /__tg/update to inject synthetic Telegram webhook updates
// - exposes GET /__tg/sent to dump captured outgoing Telegram API calls
// - exposes POST /__tg/reset to wipe captured calls
import { createServer } from 'node:http';

const captured = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (/api\.telegram\.org\/file\/bot/.test(url)) {
    try {
      const fs = await import('node:fs');
      const buf = fs.readFileSync('/tmp/harness-file.bin');
      return new Response(buf, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    } catch (_) {
      return new Response('no file', { status: 404 });
    }
  }
  if (/api\.telegram\.org\/bot/.test(url)) {
    const body = init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : null;
    const method = url.split('/bot')[1]?.split('?')[0]?.replace(/^\w+\//, '') ?? url.split('/bot')[1];
    captured.push({ method, body });
    if (/getMe|getChat|getChatMember|getFile/.test(url)) {
      return new Response(JSON.stringify({ ok: true, result: { id: 8913740917, is_bot: true, username: 'TestAthenaBot', first_name: 'TestAthena', file_path: 'documents/x' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/sendMessage|sendRichMessage|editMessageText|sendDocument|answerCallbackQuery|setMyCommands|sendChatAction|deleteMessage/.test(url)) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1000 + captured.length, chat: { id: body?.chat_id ?? 0 }, rich_message: { blocks: [] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // allow everything else (model lists etc. are not called in these tests)
  return realFetch(input, init);
};

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://athena:athena@localhost:54329/athena?sslmode=disable';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '123456:TEST-TOKEN';
process.env.TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'testsecret';
process.env.STORAGE_KEY = process.env.STORAGE_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.TG_OWNER_IDS = process.env.TG_OWNER_IDS || '6848424735,1875363508';
process.env.PORT = process.env.PORT || '3100';
process.env.NODE_ENV = 'test';

await import('../server/index.js');
await new Promise(r => setTimeout(r, 2500));

const control = createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString();
    try {
      if (req.url === '/__tg/update' && req.method === 'POST') {
        const update = JSON.parse(raw);
        const r = await realFetch(`http://127.0.0.1:${process.env.PORT}/api/telegram-webhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': process.env.TELEGRAM_WEBHOOK_SECRET },
          body: JSON.stringify(update)
        });
        const text = await r.text();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: r.status, body: text }));
      } else if (req.url === '/__tg/sent') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(captured, null, 1));
      } else if (req.url === '/__tg/reset' && req.method === 'POST') {
        captured.length = 0;
        res.writeHead(200); res.end('ok');
      } else { res.writeHead(404); res.end('nope'); }
    } catch (e) {
      res.writeHead(500); res.end(String(e && e.stack || e));
    }
  });
});
control.listen(3101, () => console.log('[harness] control on http://127.0.0.1:3101  app on :' + process.env.PORT));
