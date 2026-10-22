import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { go } from '@api3/promise-utils';
import {
  type Address,
  type Hex,
  type PublicClient,
  concatHex,
  decodeEventLog,
  hexToBigInt,
  keccak256,
  parseAbi,
  stringToHex,
  toEventSelector,
} from 'viem';
import { z } from 'zod';

export const DELEGATE_REGISTRY_ADDRESS: Address = '0x469788fe6e9e9681c6ebf3bf78e7fd26fc015446';
export const DELEGATE_REGISTRY_DEPLOYMENT_BLOCK = 11_225_329n;

const registryAbi = parseAbi([
  'event SetDelegate(address indexed delegator, bytes32 indexed id, address indexed delegation)',
  'event ClearDelegate(address indexed delegator, bytes32 indexed id, address indexed delegation)',
]);

const logSchema = z.looseObject({
  data: z.string().transform((value) => value as Hex),
  topics: z.array(z.string().transform((value) => value as Hex)),
  blockNumber: z.string().transform((value) => hexToBigInt(value as Hex)),
  logIndex: z.string().transform((value) => Number(hexToBigInt(value as Hex))),
});

const EVENT_SELECTORS = {
  set: toEventSelector(registryAbi[0]),
  clear: toEventSelector(registryAbi[1]),
};

export const GLOBAL_DELEGATION_ID: Hex = `0x${'0'.repeat(64)}`;

// Snapshot honours a registry entry keyed by the space id, by the id without its .eth suffix, and the all-spaces zero id
export const delegationIdsOfSpace = (space: string) => {
  const specific = [space, space.replace('.eth', '')].filter((id, index, ids) => ids.indexOf(id) === index);
  return { global: GLOBAL_DELEGATION_ID, specific: specific.map((id) => stringToHex(id, { size: 32 })) };
};

export type DelegationEvent = {
  kind: 'set' | 'clear';
  delegator: Address;
  id: Hex;
  delegate: Address;
  blockNumber: bigint;
  logIndex: number;
};

// Providers cap eth_getLogs ranges anywhere from ten blocks to millions, so the scan starts wide and halves the range
// whenever a request is refused
const MAX_LOG_CHUNK_SIZE = 1_000_000n;
const MIN_LOG_CHUNK_SIZE = 1000n;

// Blocks this far behind the head are final, so their events can be cached across runs
const CACHE_LAG_BLOCKS = 64n;
const CACHE_DIR = 'cache';

const cacheSchema = z.strictObject({
  ids: z.array(z.string()),
  toBlock: z.string().transform(BigInt),
  events: z.array(
    z.strictObject({
      kind: z.enum(['set', 'clear']),
      delegator: z.string().transform((value) => value as Address),
      id: z.string().transform((value) => value as Hex),
      delegate: z.string().transform((value) => value as Address),
      blockNumber: z.string().transform(BigInt),
      logIndex: z.number(),
    })
  ),
});

const cachePath = (ids: Hex[]) => join(CACHE_DIR, `delegate-registry-${keccak256(concatHex(ids)).slice(2, 18)}.json`);

const readCache = (ids: Hex[]) => {
  const path = cachePath(ids);
  if (!existsSync(path)) return null;
  const cache = cacheSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (JSON.stringify(cache.ids) !== JSON.stringify(ids)) return null;
  return cache;
};

const writeCache = (ids: Hex[], toBlock: bigint, events: DelegationEvent[]) => {
  mkdirSync(CACHE_DIR, { recursive: true });
  const serialisable = events.map((event) => ({ ...event, blockNumber: event.blockNumber.toString() }));
  writeFileSync(cachePath(ids), JSON.stringify({ ids, toBlock: toBlock.toString(), events: serialisable }));
};

const fetchLogs = async (client: PublicClient, ids: Hex[], fromBlock: bigint, toBlock: bigint) => {
  const rawLogs = await client.request({
    method: 'eth_getLogs',
    params: [
      {
        address: DELEGATE_REGISTRY_ADDRESS,
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        // Both events share the indexed layout, so one topic filter covers both and the id list narrows it to the space
        topics: [[EVENT_SELECTORS.set, EVENT_SELECTORS.clear], null, ids],
      },
    ],
  });
  return z
    .array(logSchema)
    .parse(rawLogs)
    .map((log): DelegationEvent => {
      const decoded = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      return {
        kind: decoded.eventName === 'SetDelegate' ? 'set' : 'clear',
        delegator: decoded.args.delegator.toLowerCase() as Address,
        id: decoded.args.id,
        delegate: decoded.args.delegation.toLowerCase() as Address,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
      };
    });
};

const scanLogs = async (client: PublicClient, ids: Hex[], fromBlock: bigint, toBlock: bigint) => {
  const events: DelegationEvent[] = [];
  let chunkSize = MAX_LOG_CHUNK_SIZE;
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const chunkEnd = cursor + chunkSize - 1n < toBlock ? cursor + chunkSize - 1n : toBlock;
    const result = await go(() => fetchLogs(client, ids, cursor, chunkEnd));
    if (result.success) {
      events.push(...result.data);
      cursor = chunkEnd + 1n;
      continue;
    }
    if (chunkSize <= MIN_LOG_CHUNK_SIZE) throw result.error;
    chunkSize /= 2n;
  }
  return events;
};

export const fetchDelegationEvents = async (client: PublicClient, ids: Hex[], toBlock: bigint) => {
  const cache = readCache(ids);
  const events = cache ? cache.events.filter((event) => event.blockNumber <= toBlock) : [];
  const cachedThrough = cache ? cache.toBlock : DELEGATE_REGISTRY_DEPLOYMENT_BLOCK - 1n;
  if (cachedThrough >= toBlock) return events;
  const finalBlock = (await client.getBlockNumber()) - CACHE_LAG_BLOCKS;
  const cacheableEnd = toBlock < finalBlock ? toBlock : finalBlock;
  if (cacheableEnd > cachedThrough) {
    const fresh = await scanLogs(client, ids, cachedThrough + 1n, cacheableEnd);
    writeCache(ids, cacheableEnd, [...(cache?.events ?? []), ...fresh]);
    events.push(...fresh);
  }
  if (toBlock > cacheableEnd) events.push(...(await scanLogs(client, ids, cacheableEnd + 1n, toBlock)));
  return events;
};

export type ResolvedDelegations = {
  // Every delegator with a live registry entry for the space, mapped to the delegate Snapshot credits
  delegateOf: Map<Address, Address>;
};

const byRegistryOrder = (a: DelegationEvent, b: DelegationEvent) => {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
};

// Replays the registry to its state at the block, then applies Snapshot's precedence: a space-specific entry
// wins over the all-spaces one, and between specific entries the later one wins
export const resolveDelegations = (
  events: DelegationEvent[],
  ids: { global: Hex; specific: Hex[] }
): ResolvedDelegations => {
  const ordered = [...events].sort(byRegistryOrder);
  const live = new Map<string, DelegationEvent>();
  for (const event of ordered) {
    const key = `${event.delegator}-${event.id}`;
    if (event.kind === 'set') live.set(key, event);
    else live.delete(key);
  }
  const liveOrdered = [...live.values()].sort(byRegistryOrder);
  const delegateOf = new Map<Address, Address>();
  for (const event of liveOrdered) if (event.id === ids.global) delegateOf.set(event.delegator, event.delegate);
  for (const event of liveOrdered) if (ids.specific.includes(event.id)) delegateOf.set(event.delegator, event.delegate);
  return { delegateOf };
};

export const delegatorsOf = (delegations: ResolvedDelegations, delegate: Address) =>
  [...delegations.delegateOf.entries()].filter(([, to]) => to === delegate).map(([delegator]) => delegator);
