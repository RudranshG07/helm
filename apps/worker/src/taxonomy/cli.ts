import { close } from '@mandate/db';
import { reclassify } from './reclassify.ts';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const merchant = value('merchant');

const result = await reclassify({
  ...(merchant ? { merchantId: merchant } : {}),
  apply: flag('apply'),
  allowOpenCycles: flag('allow-open-cycles'),
});

console.log(JSON.stringify(result, null, 2));
await close();
