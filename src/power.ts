import { type Address, type PublicClient } from 'viem';

import {
  type ResolvedDelegations,
  delegationIdsOfSpace,
  delegatorsOf,
  fetchDelegationEvents,
  resolveDelegations,
} from './delegation';
import { type Strategy, withDelegationParamsSchema } from './schemas';
import { type BaseScore, computeBaseScores, sumScores } from './strategies';

export type Holding = { address: Address; scores: BaseScore[] };

export type VotingPower = {
  score: number;
  // The voter's own holdings per sub-strategy, credited unless delegated away
  own: BaseScore[];
  delegatedTo: Address | null;
  delegators: Holding[];
};

// Reproduces Snapshot's with-delegation strategy: a delegate gets every delegator's holdings, plus its own unless it
// delegated to anyone itself. Delegation is one level deep, a delegate's delegators do not flow further
export const computeWithDelegation = (
  addresses: Address[],
  delegations: ResolvedDelegations,
  scoresOf: (address: Address) => BaseScore[]
): VotingPower[] =>
  addresses.map((address) => {
    const delegators = delegatorsOf(delegations, address).map((delegator) => ({
      address: delegator,
      scores: scoresOf(delegator),
    }));
    const delegatedTo = delegations.delegateOf.get(address) ?? null;
    const own = scoresOf(address);
    let score = 0;
    for (const delegator of delegators) score += sumScores(delegator.scores);
    if (!delegatedTo) score += sumScores(own);
    return { score, own, delegatedTo, delegators };
  });

export type StrategyPower = { strategy: Strategy; powers: VotingPower[] };

export const computeStrategyPowers = async (
  client: PublicClient,
  space: string,
  strategy: Strategy,
  addresses: Address[],
  blockNumber: bigint
): Promise<VotingPower[]> => {
  if (strategy.name !== 'with-delegation') {
    const scores = await computeBaseScores(client, [strategy], addresses, blockNumber);
    return addresses.map((_, index) => {
      const own = [scores[0]![index]!];
      return { score: sumScores(own), own, delegatedTo: null, delegators: [] };
    });
  }
  const params = withDelegationParamsSchema.parse(strategy.params);
  if (params.delegationNetwork && params.delegationNetwork !== strategy.network) {
    throw new Error('Delegation on another network is not supported');
  }
  const ids = delegationIdsOfSpace(params.delegationSpace ?? space);
  const events = await fetchDelegationEvents(client, [ids.global, ...ids.specific], blockNumber);
  const delegations = resolveDelegations(events, ids);
  const delegators = addresses.flatMap((address) => delegatorsOf(delegations, address));
  const holders = [...new Set([...addresses, ...delegators])];
  const scores = await computeBaseScores(client, params.strategies, holders, blockNumber);
  const scoresOf = (address: Address) => {
    const index = holders.indexOf(address);
    return scores.map((strategyScores) => strategyScores[index]!);
  };
  return computeWithDelegation(addresses, delegations, scoresOf);
};

// One entry per top-level strategy of the proposal, matching the hub's vp_by_strategy
export const computePowers = async (
  client: PublicClient,
  space: string,
  strategies: Strategy[],
  addresses: Address[],
  blockNumber: bigint
): Promise<StrategyPower[]> => {
  const result: StrategyPower[] = [];
  for (const strategy of strategies) {
    result.push({ strategy, powers: await computeStrategyPowers(client, space, strategy, addresses, blockNumber) });
  }
  return result;
};
