// cpTick.js — drain the Conversation Point queue from the command line.
//
//   npm run cp:tick
//
// Same code the in-process worker runs. Useful when the server is stopped,
// or to watch one call go through step by step with LOG_LEVEL=debug.

import { pool } from '../db.js';
import { tick } from '../conversationPoint/worker.js';
import { requeueStale } from '../conversationPoint/callStore.js';

async function main() {
  await requeueStale();
  let total = 0; let n;
  do { n = await tick(10); total += n; } while (n > 0);
  console.log(`ran ${total} steps; queue empty.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
