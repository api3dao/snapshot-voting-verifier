import { parseArgs } from 'node:util';

import { formatReport } from '../report';
import { createClient } from '../rpc';
import { verifyProposal } from '../verify';

const main = async () => {
  const { values } = parseArgs({
    options: {
      proposal: { type: 'string' },
      'archive-dir': { type: 'string', default: 'archive' },
    },
  });
  if (!values.proposal) throw new Error('--proposal <id> is required');
  const client = await createClient(1);
  const verification = await verifyProposal(client, values.proposal, values['archive-dir'], new Date());
  console.log(formatReport(verification));
  const failed = verification.problems.length > 0 || verification.voters.some((voter) => voter.problems.length);
  process.exitCode = failed ? 1 : 0;
};

void main();
