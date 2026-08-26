import { MockProposalClient } from '@mandate/core';
import { decideBatch } from '../src/decide.ts';

const base = {
  reason: 'The account was short at the time of the charge; retrying inside the days this customer usually pays.',
  confidence: 0.74,
};

const agent = new MockProposalClient({
  responses: {
    'merchant_test:sub_A': {
      action: 'RETRY_SCHEDULED',
      scheduled_for: new Date(Date.now() + 40 * 3600 * 1000).toISOString(),
      ...base,
    },
    'merchant_test:sub_B': {
      action: 'RETRY_SCHEDULED',
      scheduled_for: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
      ...base,
    },
  },
  fallback: { action: 'HOLD', reason: 'Nothing worth spending an attempt on.', confidence: 0.5 },
});

console.log('decided:', await decideBatch(agent));
process.exit(0);
