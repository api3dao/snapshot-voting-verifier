import { z } from 'zod';

import { cidOf } from './cid';

const IPFS_GATEWAY_URL = 'https://snapshot.4everland.link/ipfs';

// Signed strings keep the case the voter used, hashing them any other way changes the digest
const voteObjectSchema = z.strictObject({
  address: z.string(),
  sig: z.string(),
  hash: z.string(),
  data: z.strictObject({
    domain: z.strictObject({ name: z.string(), version: z.string() }),
    types: z.record(z.string(), z.array(z.strictObject({ name: z.string(), type: z.string() }))),
    message: z.strictObject({
      from: z.string(),
      space: z.string(),
      timestamp: z.number().int(),
      proposal: z.string(),
      choice: z.unknown(),
      reason: z.string(),
      app: z.string(),
      metadata: z.string(),
    }),
  }),
});

export type VoteObject = z.infer<typeof voteObjectSchema>;

// A space's settings message as the controller signed it. The settings are the signed JSON string, exactly as the
// controller wrote it, where the hub's space query serves its own defaults (a zero as null, a minScore of 0)
const settingsObjectSchema = z.strictObject({
  address: z.string(),
  sig: z.string(),
  hash: z.string(),
  data: z.strictObject({
    domain: z.strictObject({ name: z.string(), version: z.string() }),
    types: z.record(z.string(), z.array(z.strictObject({ name: z.string(), type: z.string() }))),
    message: z.strictObject({
      from: z.string(),
      space: z.string(),
      timestamp: z.number().int(),
      settings: z.string(),
    }),
  }),
});

export type SettingsObject = z.infer<typeof settingsObjectSchema>;

const fetchPinned = async (cid: string) => {
  const response = await fetch(`${IPFS_GATEWAY_URL}/${cid}`);
  if (!response.ok) throw new Error(`IPFS gateway returned status ${response.status} for ${cid}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualCid = cidOf(bytes);
  if (actualCid !== cid) throw new Error(`IPFS gateway returned content with CID ${actualCid} instead of ${cid}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
};

export const fetchVoteObject = async (cid: string) => voteObjectSchema.parse(await fetchPinned(cid));

export const fetchSettingsObject = async (cid: string) => settingsObjectSchema.parse(await fetchPinned(cid));
