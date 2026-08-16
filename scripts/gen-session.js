#!/usr/bin/env node
// Generate a gramjs StringSession for Athena /index_start (userbot history
// backfill). Runs interactively: asks for api_id/api_hash (my.telegram.org),
// then phone + login code (+ 2FA password if set), and prints the session
// string to paste into the bot DM.
//
// Needs the optional gramjs package: npm install telegram
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const rl = readline.createInterface({ input, output });
const ask = async (q) => (await rl.question(q)).trim();

const apiId = Number(await ask('api_id (my.telegram.org → API development tools): '));
const apiHash = await ask('api_hash: ');
if (!Number.isFinite(apiId) || apiId <= 0 || !apiHash) {
  console.error('api_id and api_hash are required.');
  process.exit(1);
}

let gramjs;
try {
  gramjs = await import('telegram');
} catch (_) {
  console.error('gramjs not installed — run: npm install telegram');
  process.exit(1);
}

const { TelegramClient } = gramjs;
const { StringSession } = gramjs.sessions;
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
await client.start({
  phoneNumber: async () => ask('Phone number (+countrycode…): '),
  password: async () => ask('2FA password (leave empty if none): '),
  phoneCode: async () => ask('Login code (Telegram → other device): '),
  onError: (err) => console.error(String(err?.message || err)),
});
rl.close();

console.log('\nSESSION STRING — paste it into /index_start in the bot DM:\n');
console.log(client.session.save());
console.log('\nTreat it like your password: it grants full account access.');
await client.disconnect();
process.exit(0);
