import { type Hex, type PublicClient, hashTypedData } from 'viem';

// The EIP-712 type of a basic or single-choice vote, from snapshot.js sign/types.ts
const VOTE_TYPES = {
  Vote: [
    { name: 'from', type: 'string' },
    { name: 'space', type: 'string' },
    { name: 'timestamp', type: 'uint64' },
    { name: 'proposal', type: 'string' },
    { name: 'choice', type: 'uint32' },
    { name: 'reason', type: 'string' },
    { name: 'app', type: 'string' },
    { name: 'metadata', type: 'string' },
  ],
} as const;

import { type HubProposal, type HubVote } from './hub';
import { fetchVoteObject } from './ipfs';

// Everything the pinned vote object has to agree on with the hub's ledger entry, plus a valid signature by the voter.
// Returns the problems found, an empty list means the vote checks out
export const verifyVoteSignature = async (client: PublicClient, proposal: HubProposal, vote: HubVote) => {
  const problems: string[] = [];
  const object = await fetchVoteObject(vote.ipfs);
  const { domain, types, message } = object.data;
  if (object.address.toLowerCase() !== vote.voter) problems.push(`pinned address ${object.address} differs from voter`);
  if (message.from.toLowerCase() !== vote.voter) problems.push(`signed from ${message.from} differs from voter`);
  if (message.space !== proposal.space.id) problems.push(`signed space ${message.space} differs from proposal space`);
  if (message.proposal !== proposal.id) problems.push('signed proposal id differs');
  if (JSON.stringify(message.choice) !== JSON.stringify(vote.choice)) {
    problems.push('signed choice differs from hub choice');
  }
  if (message.timestamp !== vote.created) problems.push('signed timestamp differs from hub created');
  if (JSON.stringify(types) !== JSON.stringify(VOTE_TYPES)) {
    problems.push('pinned EIP-712 types differ from a basic vote');
  }
  const typedData = {
    domain,
    types: VOTE_TYPES,
    primaryType: 'Vote',
    message: { ...message, timestamp: BigInt(message.timestamp), choice: Number(message.choice) },
  } as const;
  const hash = hashTypedData(typedData);
  if (hash !== object.hash) problems.push('pinned hash differs from the typed data hash');
  if (hash !== vote.id) problems.push('hub vote id differs from the typed data hash');
  const valid = await client.verifyTypedData({ ...typedData, address: vote.voter, signature: object.sig as Hex });
  if (!valid) problems.push('signature is not valid for the voter');
  return problems;
};
