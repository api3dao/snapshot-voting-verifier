import { type Address, type Hex, type PublicClient } from 'viem';

import { erc20Abi, morphoAbi, poolAbi } from '../fixture/abis';
import { API3, MORPHO, POOL } from '../fixture/wallets';
import { type Strategy, contractCallParamsSchema, withDelegationParamsSchema } from '../src/schemas';
import { scoreOf } from '../src/strategies';

// Every source of power the space's strategies read, straight from the contracts. The pool power is
// userVotingPower, the wallet's own shares plus the shares delegated to it inside the pool, scaled to API3 the way the
// math strategy does it, in floats and in the same order
export type Holdings = {
  liquid: bigint;
  deposited: bigint;
  staked: bigint;
  unstaking: bigint;
  collateral: bigint;
  pool: number;
};

export const asFloat = (wei: bigint) => scoreOf({ raw: wei, decimals: 18 });

// The market the strategies read collateral in: the first argument of the contract-call on Morpho's position()
export const morphoMarketIdOf = (strategies: Strategy[]): Hex => {
  for (const strategy of strategies) {
    const reads =
      strategy.name === 'with-delegation' ? withDelegationParamsSchema.parse(strategy.params).strategies : [];
    for (const read of reads) {
      if (read.name !== 'contract-call') continue;
      const params = contractCallParamsSchema.parse(read.params);
      if (params.methodABI.name === 'position' && typeof params.args?.[0] === 'string') return params.args[0] as Hex;
    }
  }
  throw new Error('The strategies read no Morpho position');
};

export const readHoldings = async (
  client: PublicClient,
  address: Address,
  marketId: Hex,
  blockNumber: bigint
): Promise<Holdings> => {
  const [liquid, user, staked, votingPower, totalStake, totalShares, position] = await Promise.all([
    client.readContract({ address: API3, abi: erc20Abi, functionName: 'balanceOf', args: [address], blockNumber }),
    client.readContract({ address: POOL, abi: poolAbi, functionName: 'users', args: [address], blockNumber }),
    client.readContract({ address: POOL, abi: poolAbi, functionName: 'userStake', args: [address], blockNumber }),
    client.readContract({ address: POOL, abi: poolAbi, functionName: 'userVotingPower', args: [address], blockNumber }),
    client.readContract({ address: POOL, abi: poolAbi, functionName: 'totalStake', blockNumber }),
    client.readContract({ address: POOL, abi: poolAbi, functionName: 'totalShares', blockNumber }),
    client.readContract({
      address: MORPHO,
      abi: morphoAbi,
      functionName: 'position',
      args: [marketId, address],
      blockNumber,
    }),
  ]);
  const pool = (asFloat(votingPower) * asFloat(totalStake)) / asFloat(totalShares);
  return { liquid, deposited: user[0], staked, unstaking: user[2], collateral: position[2], pool };
};

// What the strategies add up to for one wallet before delegation
export const totalPower = (of: Holdings) => asFloat(of.liquid + of.deposited + of.unstaking + of.collateral) + of.pool;
