import { type Address } from 'viem';
import { describe, expect, it } from 'vitest';

import { computeWithDelegation } from '../src/power';
import { type BaseScore } from '../src/strategies';

const alice: Address = '0x000000000000000000000000000000000000000a';
const bob: Address = '0x000000000000000000000000000000000000000b';
const carol: Address = '0x000000000000000000000000000000000000000c';

const tokens = (amount: number): BaseScore => ({ raw: BigInt(amount) * 10n ** 18n, decimals: 18 });

// Two sub-strategies, liquid and staked
const holdings: Record<Address, BaseScore[]> = {
  [alice]: [tokens(10), tokens(5)],
  [bob]: [tokens(100), tokens(0)],
  [carol]: [tokens(1000), tokens(1)],
};
const scoresOf = (address: Address) => holdings[address]!;

describe('computeWithDelegation', () => {
  it('counts every sub-strategy of an undelegated holder', () => {
    const [power] = computeWithDelegation([alice], { delegateOf: new Map() }, scoresOf);

    expect(power!.score).toBe(15);
    expect(power!.delegators).toEqual([]);
    expect(power!.delegatedTo).toBeNull();
  });

  it('moves the whole power of a delegator to the delegate', () => {
    const delegations = { delegateOf: new Map([[alice, bob]]) };
    const [alicePower, bobPower] = computeWithDelegation([alice, bob], delegations, scoresOf);

    expect(alicePower!.score).toBe(0);
    expect(alicePower!.delegatedTo).toBe(bob);
    expect(bobPower!.score).toBe(115);
    expect(bobPower!.delegators).toEqual([{ address: alice, scores: holdings[alice] }]);
  });

  it('does not chain delegations', () => {
    const delegations = {
      delegateOf: new Map<Address, Address>([
        [alice, bob],
        [bob, carol],
      ]),
    };
    const [alicePower, bobPower, carolPower] = computeWithDelegation([alice, bob, carol], delegations, scoresOf);

    expect(alicePower!.score).toBe(0);
    expect(bobPower!.score).toBe(15);
    expect(carolPower!.score).toBe(1101);
  });

  it('drops the own power of a voter who delegated to a non-voter', () => {
    const delegations = { delegateOf: new Map([[carol, alice]]) };
    const [bobPower, carolPower] = computeWithDelegation([bob, carol], delegations, scoresOf);

    expect(bobPower!.score).toBe(100);
    expect(carolPower!.score).toBe(0);
  });
});
