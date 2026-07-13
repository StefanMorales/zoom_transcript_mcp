// Self-serve check that Telegram notifications are wired up correctly. Run:
//   node --env-file=.env test_telegram.mjs
import { notifyTelegram } from './telegram.mjs';

if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
  console.log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in .env — nothing to test.');
  process.exit(1);
}

const sent = await notifyTelegram('🎩 Sorting hat test ping — if you got this, notifications are working.');
console.log(sent ? 'Sent — check Telegram.' : 'Failed — see error above.');
