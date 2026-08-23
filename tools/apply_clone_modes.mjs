import fs from 'node:fs';

const path = 'worker/index.js';
let s = fs.readFileSync(path, 'utf8');

if (!s.includes("from './clone_modes.js'")) {
  s = "import { handleCloneModeCommand } from './clone_modes.js';\n" + s;
}

// The old /clone block is the GramJS/userbot implementation. The new public
// contract reserves /clone for Bot API mode and /uclone for userbot mode.
s = s.replace(
  "if (cmd === '/clone' || cmd === '/follow' || cmd === '/backfill') {",
  "if (cmd === '/_legacy_clone' || cmd === '/follow' || cmd === '/backfill') {"
);

const marker = "     // ---- /clone (aliases /follow, /backfill): ONE command inside any chat ----";
if (!s.includes(marker)) throw new Error('legacy clone marker not found');

const dispatch = `     // ---- unified clone command layer ----
     const cloneModeResponse = await handleCloneModeCommand({
       DB: env.DB,
       env,
       token,
       chatId,
       tgUserId,
       msg,
       cmd,
       parts,
       rest,
       forumThreadId,
       athenaUser,
       isGod,
       binding,
       isSelfHosted: isSelfHosted(env),
       userbotAccounts: USERBOT_ACCOUNTS,
       MEDIA_VAULT_DIR,
       normalizeTgChatId,
       telegramApi,
       ensureUserbotTables: async () => ensureUserbotTables(env),
       ensureTransferColumns: async () => ensureTransferColumns(env),
       encryptSecret,
       startUserbotAccount,
       primeEntity,
       startBackfillJob,
       getForumTopicsViaUserbot,
       isForumEnabled,
       ensureOwnerOrAdmin: async (communityId, userId) => ensureOwnerOrAdmin(communityId, userId, env),
       send: async (text) => {
         await sendTelegramFormatted(token, chatId, text, forumThreadId);
         return new Response('OK', { status: 200, headers: corsHeaders });
       },
       escHtml,
     });
     if (cloneModeResponse) return cloneModeResponse;

`;
s = s.replace(marker, dispatch + marker);

// Replace the old, verbose channel/session cloning help with the two-mode model.
const oldHelp = /\$\{boldHtml\('Setup history backfill is now one step:'\)[\s\S]*?\$\{boldHtml\('⚠️ A session string grants full account access — revoke anytime in'\)\} \$\{italicHtml\('Telegram Settings → Devices → terminate session\.'\)\}\,?/;
const newHelp = [
  "       `${boldHtml('Cloning')}`",
  "       `${codeHtml('/clone <chat_id> <community|personal|both>')} — Bot API live indexing (bot must be admin)`,",
  "       `${codeHtml('/clone_stop [chat_id]')} — stop live clone/backfill`,",
  "       `${codeHtml('/delete <chat_id> [topic_id]')} — delete bot clone data`,",
  "       `${codeHtml('/stats')} — all bot + userbot clones and counters`,",
  "       '',",
  "       `${boldHtml('Userbot history mode')}`",
  "       `${codeHtml('/userbotconnect <api_id> <api_hash> <session> <community_id>')} — GOD, DM only`,",
  "       `${codeHtml('/uclone <chat_id> <community|personal|both>')} — full history + live`,",
  "       `${codeHtml('/uclone <chat_id> <topic_id> <target>')} — one forum topic`,",
  "       `${codeHtml('/uclone_del <chat_id> [topic_id]')} — delete userbot clone data`,",
  "       `${italicHtml('Forum groups are cloned topic-by-topic by default. Bot mode cannot backfill arbitrary old history; Telegram exposes that capability to user sessions.')}`,",
  "       `${boldHtml('⚠️ A session string grants full account access — revoke it from Telegram Settings → Devices.')}`",
].join('\n');
if (oldHelp.test(s)) s = s.replace(oldHelp, newHelp);

// Remove the migration helper from the final branch once it has done its job.
fs.writeFileSync(path, s);
