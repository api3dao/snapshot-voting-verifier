import { createPublicClient, extractChain, http } from 'viem';
import * as chains from 'viem/chains';

import { loadSecrets } from './env';

// A rate limited mainnet archive endpoint that ships with the tool, so that a holder runs it without an RPC account.
// Shared by everyone who runs it, so anything beyond a look deserves ETH_RPC_URL, which overrides it
export const DEFAULT_RPC_URL = 'https://lb.drpc.live/ethereum/Ap8y607N-kWQqs4ydkzcCwJx0S4NsO8R8YB0Mrvp6PLd';

// The RPC from ETH_RPC_URL, the environment or secrets.env, or the shipped endpoint, checked to serve the expected
// chain. The shipped endpoint is mainnet only
export const createClient = async (expectedChainId: number) => {
  loadSecrets();
  const configured = process.env.ETH_RPC_URL?.trim();
  // An empty ETH_RPC_URL, as the example file leaves it, means the shipped endpoint
  const url = configured === undefined || configured === '' ? DEFAULT_RPC_URL : configured;
  const chain = extractChain({ chains: Object.values(chains), id: expectedChainId as 1 });
  const client = createPublicClient({ chain, transport: http(url, { batch: true, timeout: 120_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== expectedChainId) {
    throw new Error(`RPC serves chain ${chainId}, expected ${expectedChainId}, set ETH_RPC_URL to a node for it`);
  }
  return client;
};
