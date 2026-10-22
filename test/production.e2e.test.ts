import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Address, type PublicClient } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AGENT, SPACE, VESTING, WALLETS } from '../fixture/wallets';
import { type VotingPower, computePowers } from '../src/power';
import { createClient } from '../src/rpc';
import { type Strategy, strategySchema, withDelegationParamsSchema } from '../src/schemas';
import { scoreOf, sumScores } from '../src/strategies';
import { scoresMatch } from '../src/tally';

import { type Holdings, asFloat, morphoMarketIdOf, readHoldings, totalPower } from './holdings';

// The strategies the api3.eth space gets, taken from the settings file, run over wallets that hold API3 in every
// place the file reads: the fixture wallets with their registry and pool delegations, a holder with collateral in the
// Kabu market, and the Vault Safe with its delegated pool shares. The recomputation has to match the raw reads and
// what Snapshot's score API computes from the same file, at a recent block

// The api3.eth settings as they will be signed, a copy of the file the space is created from. SETTINGS_PATH points
// the test at another file
const SETTINGS_PATH = process.env.SETTINGS_PATH ?? join(__dirname, 'api3-eth-settings.json');
const SCORE_API_URL = 'https://score.snapshot.org';
// Reads at the block the settings file will be judged at are final after 64 blocks, see snapshot/security.md
const BLOCKS_BEHIND_HEAD = 64n;

const VAULT: Address = '0x8e03609ed680b237c7b6f8020472ca0687308b24';
const KABU_COLLATERAL_HOLDER: Address = '0x1946a1dd383fe3c3cd9ae3066c638ef6ed7e35e5';

if (!VESTING) throw new Error('The fixture vesting is not recorded');
const vesting = VESTING;

const { staker, delegator, globalDelegator, overrider, chained } = WALLETS;
const fixtureAddresses: Address[] = [
  AGENT,
  vesting,
  staker.address,
  delegator.address,
  globalDelegator.address,
  overrider.address,
  chained.address,
];
const addresses: Address[] = [...fixtureAddresses, VAULT, KABU_COLLATERAL_HOLDER];

const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as { network: string; strategies: unknown };
const strategies: Strategy[] = z.array(strategySchema).parse(settings.strategies);

let client: PublicClient;
let blockNumber: bigint;
let holdings: Record<Address, Holdings>;
let powers: Record<Address, VotingPower>;

const expectScore = (actual: number, expected: number) => {
  expect(scoresMatch(expected, actual), `${actual} should be ${expected}`).toBe(true);
};

beforeAll(async () => {
  client = await createClient(Number(settings.network));
  blockNumber = (await client.getBlockNumber()) - BLOCKS_BEHIND_HEAD;
  const marketId = morphoMarketIdOf(strategies);
  holdings = Object.fromEntries(
    await Promise.all(
      addresses.map(async (address) => [address, await readHoldings(client, address, marketId, blockNumber)] as const)
    )
  );
  // The fixture wallets delegated under the sandbox space id, so that is the space the registry is read for
  const strategyPowers = await computePowers(client, SPACE, strategies, addresses, blockNumber);

  expect(strategyPowers).toHaveLength(1);

  powers = Object.fromEntries(addresses.map((address, index) => [address, strategyPowers[0]!.powers[index]!]));
});

describe('the settings file', () => {
  it('holds one with-delegation strategy over the five sources of power', () => {
    expect(strategies).toHaveLength(1);
    expect(strategies[0]!.name).toBe('with-delegation');

    const reads = withDelegationParamsSchema.parse(strategies[0]!.params).strategies;

    expect(reads.map((read) => read.name)).toEqual([
      'erc20-balance-of',
      'math',
      'contract-call',
      'contract-call',
      'contract-call',
    ]);
  });
});

describe('a wallet with every source of power', () => {
  it('holds API3 liquid, deposited, staked, unstaking and as Kabu collateral, and delegated its stake away', () => {
    const of = holdings[staker.address]!;

    expect(of.liquid).toBeGreaterThan(0n);
    expect(of.deposited).toBeGreaterThan(0n);
    expect(of.staked).toBeGreaterThan(0n);
    expect(of.unstaking).toBeGreaterThan(0n);
    expect(of.collateral).toBe(staker.kabu);
    expect(of.pool).toBe(0);
  });

  it('is credited with each source, the pool through userVotingPower, plus its registry delegators', () => {
    const power = powers[staker.address]!;
    const [liquid, pool, deposited, unstaking, collateral] = power.own.map((score) => scoreOf(score)) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const of = holdings[staker.address]!;

    expectScore(liquid, asFloat(of.liquid));
    expectScore(pool, of.pool);
    expectScore(deposited, asFloat(of.deposited));
    expectScore(unstaking, asFloat(of.unstaking));
    expectScore(collateral, asFloat(of.collateral));

    expect(power.delegators.map((holder) => holder.address).sort()).toEqual(
      [globalDelegator.address, overrider.address].sort()
    );

    expectScore(
      power.score,
      totalPower(of) + totalPower(holdings[globalDelegator.address]!) + totalPower(holdings[overrider.address]!)
    );
  });
});

describe('a wallet that delegated to another', () => {
  it('keeps nothing itself, the delegate gets everything it holds, pool delegations to it included', () => {
    const delegatorPower = powers[delegator.address]!;
    const agentPower = powers[AGENT]!;
    const delegatorHoldings = holdings[delegator.address]!;

    expect(delegatorPower.delegatedTo).toBe(AGENT);

    // Its own power went to the agent, only the chained wallet's delegation stays with it
    expectScore(delegatorPower.score, totalPower(holdings[chained.address]!));
    // The staker delegated its stake to the delegator inside the pool, so the delegator's pool power is both stakes.
    // userStake rounds each stake down to a wei, the shares behind userVotingPower do not
    const bothStakes = asFloat(holdings[staker.address]!.staked + delegatorHoldings.staked);

    expect(Math.abs(delegatorHoldings.pool - bothStakes)).toBeLessThan(asFloat(2n));

    const delegatorInAgent = agentPower.delegators.find((holder) => holder.address === delegator.address)!;

    expectScore(sumScores(delegatorInAgent.scores), totalPower(delegatorHoldings));
    expectScore(
      agentPower.score,
      totalPower(holdings[AGENT]!) + totalPower(holdings[vesting]!) + totalPower(delegatorHoldings)
    );
  });

  it('moves the stake the staker delegated inside the pool to the delegator, and on to the agent', () => {
    // A delegated to B in the pool, B delegated to C in the registry: C votes with A's stake, A and B do not
    const stakerHoldings = holdings[staker.address]!;
    const delegatorHoldings = holdings[delegator.address]!;

    expect(stakerHoldings.staked).toBeGreaterThan(0n);
    expect(stakerHoldings.pool).toBe(0);
    expect(scoreOf(powers[staker.address]!.own[1]!)).toBe(0);

    // userStake rounds each stake down to a wei, the shares behind userVotingPower do not
    const bothStakes = asFloat(stakerHoldings.staked + delegatorHoldings.staked);

    expect(Math.abs(delegatorHoldings.pool - bothStakes)).toBeLessThan(asFloat(2n));

    // The pool read the registry delegation hands the agent is the delegator's, the staker's stake inside it
    const delegatorInAgent = powers[AGENT]!.delegators.find((holder) => holder.address === delegator.address)!;
    const poolViaDelegator = scoreOf(delegatorInAgent.scores[1]!);

    expectScore(poolViaDelegator, delegatorHoldings.pool);

    expect(poolViaDelegator).toBeGreaterThanOrEqual(asFloat(stakerHoldings.staked));
    expect(powers[delegator.address]!.delegators.map((holder) => holder.address)).toEqual([chained.address]);
  });

  for (const [name, address, delegatedTo] of [
    ['vesting', vesting, AGENT],
    ['global delegator', globalDelegator.address, staker.address],
    ['overrider', overrider.address, staker.address],
    ['chained wallet', chained.address, delegator.address],
  ] as const) {
    it(`leaves the ${name} with zero power`, () => {
      const power = powers[address]!;

      expect(power.score).toBe(0);
      expect(power.delegatedTo).toBe(delegatedTo);
    });
  }
});

describe('wallets outside the fixture', () => {
  it('counts the Kabu market collateral of a holder', () => {
    const of = holdings[KABU_COLLATERAL_HOLDER]!;
    const power = powers[KABU_COLLATERAL_HOLDER]!;

    expect(of.collateral).toBeGreaterThan(0n);

    expectScore(scoreOf(power.own[4]!), asFloat(of.collateral));
  });

  it('credits the Vault Safe with the pool shares delegated to it', () => {
    const of = holdings[VAULT]!;
    const power = powers[VAULT]!;

    expect(of.staked).toBe(0n);
    expect(of.pool).toBeGreaterThan(1_000_000);

    expectScore(scoreOf(power.own[1]!), of.pool);
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
          params: { address, network: settings.network, snapshot: Number(blockNumber), space: SPACE, strategies },
        }),
      });
      const body = (await response.json()) as { result?: { vp: number; vp_by_strategy: number[] }; error?: unknown };

      expect(body.error).toBeUndefined();
      expect(
        scoresMatch(body.result!.vp, powers[address]!.score),
        `${body.result!.vp} vs ${powers[address]!.score}`
      ).toBe(true);
    });
  }
});
