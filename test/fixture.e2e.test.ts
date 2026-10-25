import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Address, type PublicClient } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';

import { morphoAbi } from '../fixture/abis';
import {
  AGENT,
  MORPHO,
  MORPHO_MARKET_ID,
  PROPOSAL_ID,
  SPACE,
  VESTING,
  VESTING_AMOUNT,
  WALLETS,
} from '../fixture/wallets';
import { fetchProposal, fetchSpace } from '../src/hub';
import { type VotingPower, computePowers } from '../src/power';
import { createClient } from '../src/rpc';
import { type Strategy } from '../src/schemas';
import { sumScores } from '../src/strategies';
import { scoresMatch } from '../src/tally';
import { verifyProposal } from '../src/verify';

import { type Holdings, asFloat, morphoMarketIdOf, readHoldings, totalPower } from './holdings';

// The mainnet fixture fixture/setup.ts deployed, under the strategies the sandbox space runs today, checked from three
// angles: the recomputation against the raw holdings, Snapshot's score API, and the hub's ledger of the fixture proposal

const SCORE_API_URL = 'https://score.snapshot.org';

if (!VESTING || !PROPOSAL_ID) throw new Error('The fixture vesting and proposal are not recorded');
const vesting = VESTING;
const proposalId = PROPOSAL_ID;

const { staker, delegator, globalDelegator, overrider, chained } = WALLETS;
const addresses: Address[] = [
  AGENT,
  vesting,
  staker.address,
  delegator.address,
  globalDelegator.address,
  overrider.address,
  chained.address,
];

let client: PublicClient;
let strategies: Strategy[];
let blockNumber: bigint;
let holdings: Record<Address, Holdings>;
let powers: Record<Address, VotingPower>;

const expectScore = (actual: number, expected: number) => {
  expect(scoresMatch(expected, actual), `${actual} should be ${expected}`).toBe(true);
};

beforeAll(async () => {
  const space = await fetchSpace(SPACE);
  ({ strategies } = space);
  client = await createClient(Number(space.network));
  const proposal = await fetchProposal(proposalId);
  blockNumber = proposal.snapshot;
  const marketId = morphoMarketIdOf(strategies);
  holdings = Object.fromEntries(
    await Promise.all(
      addresses.map(async (address) => [address, await readHoldings(client, address, marketId, blockNumber)] as const)
    )
  );
  const strategyPowers = await computePowers(client, SPACE, strategies, addresses, blockNumber);

  expect(strategyPowers).toHaveLength(1);

  powers = Object.fromEntries(addresses.map((address, index) => [address, strategyPowers[0]!.powers[index]!]));
});

describe('on-chain holdings', () => {
  it('gives the staker a nonzero liquid, deposited, staked and unstaking amount', () => {
    const of = holdings[staker.address]!;

    expect(of.liquid).toBe(staker.liquid);
    expect(of.deposited).toBe(staker.deposit - staker.stake);
    expect(of.staked).toBeGreaterThan(0n);
    expect(of.unstaking).toBe(staker.unstake);
  });

  it('keeps the staker collateral in the mock Morpho market', async () => {
    const position = await client.readContract({
      address: MORPHO,
      abi: morphoAbi,
      functionName: 'position',
      args: [MORPHO_MARKET_ID, staker.address],
      blockNumber,
    });

    expect(position[2]).toBe(staker.morpho);
  });

  it('funds the vesting with the agreed amount', () => {
    expect(holdings[vesting]!.liquid).toBe(VESTING_AMOUNT);
  });
});

describe('recomputed power', () => {
  it('credits the staker with its own sources plus the global delegator and the overrider', () => {
    const power = powers[staker.address]!;

    expect(power.delegatedTo).toBeNull();
    expect(power.delegators.map((delegator) => delegator.address).sort()).toEqual(
      [globalDelegator.address, overrider.address].sort()
    );

    const expected =
      totalPower(holdings[staker.address]!) +
      totalPower(holdings[globalDelegator.address]!) +
      totalPower(holdings[overrider.address]!);

    expectScore(power.score, expected);
    expectScore(sumScores(power.own), totalPower(holdings[staker.address]!));
  });

  it('credits the agent with its own sources, the vesting and the delegator, not the overrider', () => {
    const power = powers[AGENT]!;

    expect(power.delegatedTo).toBeNull();
    expect(power.delegators.map((delegator) => delegator.address).sort()).toEqual([vesting, delegator.address].sort());

    const expected = totalPower(holdings[AGENT]!) + asFloat(VESTING_AMOUNT) + totalPower(holdings[delegator.address]!);

    expectScore(power.score, expected);
  });

  it('credits the delegator with the chained wallet only', () => {
    const power = powers[delegator.address]!;

    expect(power.delegatedTo).toBe(AGENT);
    expect(power.delegators.map((delegator) => delegator.address)).toEqual([chained.address]);

    expectScore(power.score, totalPower(holdings[chained.address]!));
  });

  for (const [name, address, delegatedTo] of [
    ['vesting', vesting, AGENT],
    ['global delegator', globalDelegator.address, staker.address],
    ['overrider', overrider.address, staker.address],
    ['chained wallet', chained.address, delegator.address],
  ] as const) {
    it(`gives the ${name} zero power and names its delegate`, () => {
      const power = powers[address]!;

      expect(power.score).toBe(0);
      expect(power.delegatedTo).toBe(delegatedTo);
      expect(power.delegators).toEqual([]);
    });
  }

  it('moves the stake the staker delegated inside the pool to the delegator, and on to the agent', () => {
    const stakerHoldings = holdings[staker.address]!;
    const delegatorHoldings = holdings[delegator.address]!;

    expect(stakerHoldings.staked).toBeGreaterThan(0n);
    expect(stakerHoldings.pool).toBe(0);

    // userStake rounds each stake down to a wei, the shares behind userVotingPower do not
    const bothStakes = asFloat(stakerHoldings.staked + delegatorHoldings.staked);

    expect(Math.abs(delegatorHoldings.pool - bothStakes)).toBeLessThan(asFloat(2n));

    // The delegator's own holdings, stake delegated to it included, are what the registry delegation hands the agent
    const delegatorInAgent = powers[AGENT]!.delegators.find((holder) => holder.address === delegator.address)!;

    expectScore(sumScores(delegatorInAgent.scores), totalPower(delegatorHoldings));
  });
});

describe('score API agreement', () => {
  for (const address of addresses) {
    it(`matches Snapshot for ${address}`, async () => {
      const response = await fetch(SCORE_API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'get_vp',
          params: { address, network: '1', snapshot: Number(blockNumber), space: SPACE, strategies },
        }),
      });
      const body = (await response.json()) as { result?: { vp: number; vp_by_strategy: number[] }; error?: unknown };

      expect(body.error).toBeUndefined();
      expect(scoresMatch(body.result!.vp, powers[address]!.score)).toBe(true);
    });
  }
});

describe('hub agreement on the fixture proposal', () => {
  it('reproduces the votes of the agent and the staker and the tally', async () => {
    const archiveDir = mkdtempSync(join(tmpdir(), 'vote-verification-fixture-'));
    const verification = await verifyProposal(client, proposalId, archiveDir, new Date());

    expect(verification.proposal.snapshot).toBe(blockNumber);

    const voters = Object.fromEntries(verification.voters.map((voter) => [voter.vote.voter, voter]));

    expect(Object.keys(voters).sort()).toEqual([AGENT, staker.address].sort());

    for (const voter of verification.voters) {
      // The proposal carries the strategies it was created with, so its powers are the hub's, not the space's today
      expect(voter.score).toBe(voters[voter.vote.voter]!.score);

      const pending = voter.vote.vp_state === 'final' ? [] : ['hub power is pending, not final'];

      expect(voter.problems).toEqual(pending);
    }

    expect(verification.scores).toEqual(verification.proposal.scores);

    const pending = verification.proposal.scores_state === 'final' ? [] : ['hub scores are pending, not final'];

    // The fixture proposal predates the rehearsal settings of the sandbox space: the old quorum, which the sandbox
    // rule set reports as bypassed
    expect(verification.problems).toEqual([
      ...pending,
      `rule bypassed: quorum of ${(1e25).toLocaleString('en-US')} set on the proposal, 300 expected`,
    ]);
    expect(verification.rules?.outcome).toBe('not to be executed, a rule was bypassed');
  });
});
