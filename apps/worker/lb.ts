import { close } from '@mandate/db';
import { cleanup, runLiveBatch } from './src/batch/live.ts';
const r = await runLiveBatch({ count: 40 });
console.log(JSON.stringify(r, null, 1));
await cleanup(r.merchant_id);
await close();
