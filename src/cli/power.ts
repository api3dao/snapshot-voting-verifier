import { parseArgs } from 'node:util';

import { type Address } from 'viem';

import { fetchSpace } from '../hub';
import { computePowers } from '../power';
import { createClient } from '../rpc';
import { addressSchema } from '../schemas';
import { scoreOf } from '../strategies';

// Voting power of arbitrary addresses under a space's current strategies, for checking a holder before a vote
const main = async () => {
  const { values } = parseArgs({
    options: {
      space: { type: 'string' },
      address: { type: 'string', multiple: true },
      block: { type: 'string' },
    },
  });
  if (!values.space) throw new Error('--space <id> is required');
  if (!values.address?.length) throw new Error('at least one --address is required');
  const addresses: Address[] = values.address.map((address) => addressSchema.parse(address));
  const space = await fetchSpace(values.space);
  const client = await createClient(Number(space.network));
  const blockNumber = values.block ? BigInt(values.block) : await client.getBlockNumber();
  const strategyPowers = await computePowers(client, space.id, space.strategies, addresses, blockNumber);
  console.log(`${space.id} at block ${blockNumber}`);
  for (const [index, address] of addresses.entries()) {
    let total = 0;
    for (const strategyPower of strategyPowers) total += strategyPower.powers[index]!.score;
    console.log(`${address}: ${total}`);
    for (const strategyPower of strategyPowers) {
      const power = strategyPower.powers[index]!;
      console.log(`  ${strategyPower.strategy.name}: ${power.score}`);
      console.log(
        `    own ${power.own.map((score) => scoreOf(score)).join(', ')}${power.delegatedTo ? ` delegated to ${power.delegatedTo}` : ''}`
      );
      for (const delegator of power.delegators) {
        console.log(`    from ${delegator.address}: ${delegator.scores.map((score) => scoreOf(score)).join(', ')}`);
      }
    }
  }
};

void main();
