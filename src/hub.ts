import { z } from 'zod';

import { loadSecrets } from './env';
import { addressSchema, strategySchema } from './schemas';

const HUB_URL = 'https://hub.snapshot.org/graphql';
const VOTES_PAGE_SIZE = 1000;

const proposalSchema = z.strictObject({
  id: z.string(),
  ipfs: z.string(),
  space: z.strictObject({ id: z.string() }),
  network: z.string(),
  type: z.string(),
  state: z.string(),
  title: z.string(),
  author: addressSchema,
  labels: z.array(z.string()),
  choices: z.array(z.string()),
  start: z.number().int(),
  end: z.number().int(),
  snapshot: z.number().int().transform(BigInt),
  created: z.number().int(),
  votes: z.number().int(),
  scores: z.array(z.number()),
  scores_by_strategy: z.array(z.array(z.number())),
  scores_total: z.number(),
  scores_state: z.string(),
  quorum: z.number(),
  strategies: z.array(strategySchema),
});

export type HubProposal = z.infer<typeof proposalSchema>;

const voteSchema = z.strictObject({
  id: z.string(),
  ipfs: z.string(),
  voter: addressSchema,
  choice: z.unknown(),
  vp: z.number(),
  vp_by_strategy: z.array(z.number()),
  vp_state: z.string(),
  created: z.number().int(),
  reason: z.string(),
  app: z.string(),
  metadata: z.unknown(),
});

export type HubVote = z.infer<typeof voteSchema>;

const spaceSchema = z.strictObject({
  id: z.string(),
  network: z.string(),
  strategies: z.array(strategySchema),
});

export type HubSpace = z.infer<typeof spaceSchema>;

// Keyless access to the hub is rate limited, SNAPSHOT_API_KEY lifts that
const graphql = async (query: string, variables: Record<string, unknown>) => {
  loadSecrets();
  const apiKey = process.env.SNAPSHOT_API_KEY;
  const response = await fetch(HUB_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Hub request failed with status ${response.status}`);
  const body = z.strictObject({ data: z.record(z.string(), z.unknown()) }).parse(await response.json());
  return body.data;
};

const PROPOSAL_FIELDS = `id ipfs space { id } network type state title author labels choices start end snapshot created votes
  scores scores_by_strategy scores_total scores_state quorum strategies { name network params }`;

export const fetchProposal = async (id: string) => {
  const data = await graphql(`query ($id: String!) { proposal(id: $id) { ${PROPOSAL_FIELDS} } }`, { id });
  if (!data.proposal) throw new Error(`Proposal ${id} not found on the hub`);
  return proposalSchema.parse(data.proposal);
};

const messageSchema = z.strictObject({ mci: z.number().int(), timestamp: z.number().int() });

// The hub numbers every message it receives (mci). The signed timestamps of the messages it received right before a
// proposal bound when the proposal itself was received, whatever the proposal's own timestamp claims: each of them
// was signed no later than it was received, and received before the proposal was
export const fetchReceivedAfter = async (proposalId: string) => {
  const own = await graphql(
    `
      query ($id: String!) {
        messages(where: { id: $id }) {
          mci
          timestamp
        }
      }
    `,
    {
      id: proposalId,
    }
  );
  const [message] = z.array(messageSchema).parse(own.messages);
  if (!message) throw new Error(`The hub has no message for proposal ${proposalId}`);
  const before = await graphql(
    `
      query ($mci: Int!) {
        messages(first: 10, where: { mci_lt: $mci }, orderBy: "mci", orderDirection: desc) {
          mci
          timestamp
        }
      }
    `,
    { mci: message.mci }
  );
  const neighbours = z.array(messageSchema).parse(before.messages);
  if (neighbours.length === 0) throw new Error(`The hub has no messages before ${message.mci}`);
  return Math.max(...neighbours.map((neighbour) => neighbour.timestamp));
};

const VOTE_FIELDS = 'id ipfs voter choice vp vp_by_strategy vp_state created reason app metadata';

export const fetchVotes = async (proposalId: string) => {
  const votesById = new Map<string, HubVote>();
  let createdCursor = 0;
  while (true) {
    const data = await graphql(
      `query ($proposal: String!, $first: Int!, $created: Int!) {
        votes(first: $first, orderBy: "created", orderDirection: asc,
          where: { proposal: $proposal, created_gte: $created }) { ${VOTE_FIELDS} }
      }`,
      { proposal: proposalId, first: VOTES_PAGE_SIZE, created: createdCursor }
    );
    const page = z.array(voteSchema).parse(data.votes);
    for (const vote of page) votesById.set(vote.id, vote);
    if (page.length < VOTES_PAGE_SIZE) break;
    const lastCreated = page.at(-1)!.created;
    if (lastCreated === createdCursor) throw new Error('Cannot page through votes, too many share one timestamp');
    createdCursor = lastCreated;
  }
  return [...votesById.values()].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
};

export const fetchSpace = async (id: string) => {
  const data = await graphql(
    `
      query ($id: String!) {
        space(id: $id) {
          id
          network
          strategies {
            name
            network
            params
          }
        }
      }
    `,
    {
      id,
    }
  );
  if (!data.space) throw new Error(`Space ${id} not found on the hub`);
  return spaceSchema.parse(data.space);
};
