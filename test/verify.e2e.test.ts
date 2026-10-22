import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createClient } from '../src/rpc';
import { verifyProposal } from '../src/verify';

// A closed dorg.eth proposal on the same with-delegation strategy the API3 space uses, with one vote cast entirely
// through a delegation. Swap it for an API3 proposal once the space has a closed vote
const PROPOSAL_ID = '0xe67f35bb955749400559b2e5d54e29be5a215bb83a0bc5c51e563695854881bb';
// The Routine proposal of the rehearsal on the sandbox space, 2026-10-20: posted by the agent wallet under the
// production settings with the thresholds scaled and 30 minutes of voting, voted For by the agent and two fixture
// wallets and Abstain by the test Safe through EIP-1271, the quorum of 300 met by the abstain alone. The sandbox
// has run the production week of voting since 2026-10-22, so the rule set reports its period as bypassed
const REHEARSAL_PROPOSAL_ID = '0xeb4bc9af28d4930ea43c52aba8538962dcbe51231a0a5854bf0aa106c5330f61';
const AGENT = '0x966ee27c6b758dc9c820b578b7fdab006ed41151';

describe('verifyProposal', () => {
  it('checks the rehearsal proposal against the sandbox rules, every rule but the period since changed', async () => {
    const client = await createClient(1);
    const archiveDir = mkdtempSync(join(tmpdir(), 'vote-verification-'));
    const verification = await verifyProposal(client, REHEARSAL_PROPOSAL_ID, archiveDir, new Date());

    expect(verification.voters).toHaveLength(4);

    for (const voter of verification.voters) expect(voter.problems).toEqual([]);

    expect(verification.problems).toEqual(['rule bypassed: voting period of 1800 seconds, 604800 expected']);
    expect(verification.proposal.author).toBe(AGENT);
    expect(verification.proposal.labels).toEqual(['routine']);
    // The agent's own power, the one it also voted with
    expect(verification.authorPower).toBe(verification.voters.find((voter) => voter.vote.voter === AGENT)!.score);
    expect(verification.authorPower).toBeGreaterThan(5);
    expect(verification.rules?.checks.map((check) => check.ok)).toEqual([
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
    ]);
    expect(verification.rules?.outcome).toBe('not to be executed, a rule was bypassed');
  });

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
    // dorg.eth has no rule set, so only the tally is reported
    expect(verification.rules).toBeNull();
  });
});
