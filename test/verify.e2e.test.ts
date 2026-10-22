import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createClient } from '../src/rpc';
import { verifyProposal } from '../src/verify';

// A closed dorg.eth proposal on the same with-delegation strategy the API3 space uses, with one vote cast entirely
// through a delegation. Swap it for an API3 proposal once the space has a closed vote
const PROPOSAL_ID = '0xe67f35bb955749400559b2e5d54e29be5a215bb83a0bc5c51e563695854881bb';

describe('verifyProposal', () => {
  it('reproduces the hub ledger of a closed proposal from the chain', async () => {
    const client = await createClient(1);
    const archiveDir = mkdtempSync(join(tmpdir(), 'vote-verification-'));
    const verification = await verifyProposal(client, PROPOSAL_ID, archiveDir, new Date());

    expect(verification.voters).toHaveLength(10);

    for (const voter of verification.voters) expect(voter.problems).toEqual([]);

    expect(verification.scores).toEqual(verification.proposal.scores);

    const delegated = verification.voters.find(
      (voter) => voter.vote.voter === '0x584a59133c269a19add6c5758032f1f1334ee573'
    );

    expect(delegated?.powers[0]?.powers[0]?.delegators.map((delegator) => delegator.address)).toEqual([
      '0x7baca1e69390ac9f57f9e86462a77c9898bec066',
    ]);
    // dOrg takes Snapshot's default snapshot block, the latest one at creation, which the API3 process forbids
    expect(verification.problems).toEqual(['snapshot block is fewer than 64 blocks before the proposal creation']);
    expect(verification.archiveDiff).toBeNull();
  });
});
