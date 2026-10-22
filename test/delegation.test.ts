import { describe, expect, it } from 'vitest';

import { type DelegationEvent, delegationIdsOfSpace, delegatorsOf, resolveDelegations } from '../src/delegation';

const ids = delegationIdsOfSpace('api3.eth');
const [fullId, shortId] = ids.specific as [`0x${string}`, `0x${string}`];

const alice = '0x000000000000000000000000000000000000000a';
const bob = '0x000000000000000000000000000000000000000b';
const carol = '0x000000000000000000000000000000000000000c';

let logIndex = 0;
const event = (
  kind: DelegationEvent['kind'],
  delegator: string,
  id: `0x${string}`,
  delegate: string,
  blockNumber = 100n
) => ({ kind, delegator, id, delegate, blockNumber, logIndex: logIndex++ }) as DelegationEvent;

describe('delegationIdsOfSpace', () => {
  it('derives the zero id, the space id and the id without the suffix', () => {
    expect(ids.global).toBe(`0x${'0'.repeat(64)}`);
    expect(fullId).toBe('0x617069332e657468000000000000000000000000000000000000000000000000');
    expect(shortId).toBe('0x6170693300000000000000000000000000000000000000000000000000000000');
  });

  it('does not repeat the id for a space without the suffix', () => {
    expect(delegationIdsOfSpace('api3').specific).toHaveLength(1);
  });
});

describe('resolveDelegations', () => {
  it('credits the delegate of a live entry', () => {
    const delegations = resolveDelegations([event('set', alice, fullId, bob)], ids);

    expect(delegations.delegateOf.get(alice)).toBe(bob);
    expect(delegatorsOf(delegations, bob)).toEqual([alice]);
  });

  it('forgets a cleared entry', () => {
    const delegations = resolveDelegations(
      [event('set', alice, fullId, bob, 100n), event('clear', alice, fullId, bob, 101n)],
      ids
    );

    expect(delegations.delegateOf.size).toBe(0);
  });

  it('follows the registry order rather than the log order it received', () => {
    const cleared = event('clear', alice, fullId, bob, 101n);
    const set = event('set', alice, fullId, bob, 100n);

    expect(resolveDelegations([cleared, set], ids).delegateOf.size).toBe(0);
  });

  it('replaces the delegate when the registry clears and sets in one transaction', () => {
    const delegations = resolveDelegations(
      [
        event('set', alice, fullId, bob, 100n),
        event('clear', alice, fullId, bob, 101n),
        event('set', alice, fullId, carol, 101n),
      ],
      ids
    );

    expect(delegations.delegateOf.get(alice)).toBe(carol);
  });

  it('lets the space entry win over the all-spaces entry regardless of age', () => {
    const delegations = resolveDelegations(
      [event('set', alice, fullId, bob, 100n), event('set', alice, ids.global, carol, 200n)],
      ids
    );

    expect(delegations.delegateOf.get(alice)).toBe(bob);
  });

  it('falls back to the all-spaces entry', () => {
    const delegations = resolveDelegations([event('set', alice, ids.global, carol)], ids);

    expect(delegations.delegateOf.get(alice)).toBe(carol);
  });

  it('lets the later of the two space entries win', () => {
    const delegations = resolveDelegations(
      [event('set', alice, fullId, bob, 100n), event('set', alice, shortId, carol, 200n)],
      ids
    );

    expect(delegations.delegateOf.get(alice)).toBe(carol);
  });

  it('ignores entries for other ids', () => {
    const otherId = '0x6f746865722e6574680000000000000000000000000000000000000000000000';

    expect(resolveDelegations([event('set', alice, otherId, bob)], ids).delegateOf.size).toBe(0);
  });
});
