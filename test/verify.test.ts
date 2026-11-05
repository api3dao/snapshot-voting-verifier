import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Address, HttpRequestError, type PublicClient, createPublicClient, hashTypedData, http } from 'viem';
import { mainnet } from 'viem/chains';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cidOf } from '../src/cid';
import { scoreOf } from '../src/strategies';
import { MAX_SNAPSHOT_AGE_BLOCKS, snapshotAgeProblems, verifyProposal } from '../src/verify';

const received = 1_792_500_000;
const SLOT = 12;
const tooOld = `snapshot block is more than ${MAX_SNAPSHOT_AGE_BLOCKS} blocks before the hub received the proposal`;

// When the block MAX after the snapshot block was mined, for a snapshot `age` blocks before the receipt
const afterMaxAge = (age: bigint) => received - Number(age - MAX_SNAPSHOT_AGE_BLOCKS) * SLOT;

describe('snapshotAgeProblems', () => {
  it("accepts Snapshot's default, the latest block at posting", () => {
    expect(snapshotAgeProblems(received, afterMaxAge(1n))).toEqual([]);
    expect(snapshotAgeProblems(received, afterMaxAge(0n))).toEqual([]);
  });

  it('accepts a block up to the maximum age, a Safe proposal delivered a day after its first signature', () => {
    expect(snapshotAgeProblems(received, afterMaxAge(100n))).toEqual([]);
    expect(snapshotAgeProblems(received, afterMaxAge(MAX_SNAPSHOT_AGE_BLOCKS))).toEqual([]);
  });

  it('accepts a recent block whose maximum age block is not mined yet', () => {
    expect(snapshotAgeProblems(received, undefined)).toEqual([]);
  });

  it('rejects a block one past the maximum age', () => {
    expect(snapshotAgeProblems(received, afterMaxAge(MAX_SNAPSHOT_AGE_BLOCKS + 1n))).toEqual([tooOld]);
  });

  it('rejects a block from years ago, which the sequencer accepts', () => {
    expect(snapshotAgeProblems(received, afterMaxAge(10_000_000n))).toEqual([tooOld]);
  });
});

// A proposal on the sandbox, whose rules want a minute of delay, a week of voting and 300 in favour, counting API3 held
// at the snapshot block
const SANDBOX = 'testing-new-d-ignore-xyz-a.eth';
const PROPOSAL_ID = `0x${'e'.repeat(64)}`;
const OTHER_PROPOSAL_ID = `0x${'f'.repeat(64)}`;
const PROPOSAL_MCI = 1000;
const SNAPSHOT = 23_600_000n;
const AUTHOR: Address = '0x966ee27c6b758dc9c820b578b7fdab006ed41151';
const API3: Address = '0x0b38210ea11411557c13457d4da7dc6ea731b88a';
const IPFS_GATEWAY_URL = 'https://snapshot.4everland.link/ipfs/';
const start = received + 60;
const end = start + 7 * 86_400;
const tied = start + 3600;

const alice: Address = '0x000000000000000000000000000000000000000a';
const bob: Address = '0x000000000000000000000000000000000000000b';
const voterAt = (index: number) => `0x1${index.toString(16).padStart(39, '0')}` as Address;

const tokens = (amount: number) => BigInt(amount) * 10n ** 18n;

const DOMAIN = { name: 'snapshot', version: '0.1.4' };
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

// A vote as the hub lists it, with the object pinned under its CID and the balance its voter holds
const castVote = (
  voter: Address,
  choice: number,
  balance: bigint,
  { created = start + 60, space = SANDBOX, proposal = PROPOSAL_ID, sig = `0x${'00'.repeat(65)}` } = {}
) => {
  const message = {
    from: voter,
    space,
    timestamp: created,
    proposal,
    choice,
    reason: '',
    app: 'snapshot',
    metadata: '',
  };
  const typedMessage = { ...message, timestamp: BigInt(created) };
  const id = hashTypedData({ domain: DOMAIN, types: VOTE_TYPES, primaryType: 'Vote', message: typedMessage });
  const pinned = JSON.stringify({
    address: voter,
    sig,
    hash: id,
    data: { domain: DOMAIN, types: VOTE_TYPES, message },
  });
  const vp = scoreOf({ raw: balance, decimals: 18 });
  const row = {
    id,
    ipfs: cidOf(new TextEncoder().encode(pinned)),
    voter,
    choice,
    vp,
    vp_by_strategy: [vp],
    vp_state: 'final',
    created,
    reason: '',
    app: 'snapshot',
    metadata: {},
  };
  return { proposal, balance, pinned, row };
};

type CastVote = ReturnType<typeof castVote>;

// The hub's vote messages, numbered in the order given after the proposal's
const messagesOf = (votes: CastVote[], space = SANDBOX) =>
  votes.map((vote, index) => ({ id: vote.row.id, mci: PROPOSAL_MCI + 1 + index, space, timestamp: vote.row.created }));

// The order the run lists votes in
const idsInOrder = (votes: CastVote[]) =>
  votes
    .map((vote) => vote.row)
    .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
    .map((row) => row.id);

// `count` votes sharing the tied timestamp, between a vote a second before it and one a second after
const tiedVotes = (count: number) => [
  castVote(voterAt(0), 1, 0n, { created: tied - 1 }),
  ...Array.from({ length: count }, (_, index) => castVote(voterAt(index + 1), 1, 0n, { created: tied })),
  castVote(voterAt(count + 1), 1, 0n, { created: tied + 1 }),
];

const validSignaturesExcept =
  (...voters: Address[]) =>
  async ({ address }: { address: Address }) =>
    !voters.includes(address);

// Runs the verification against a hub that lists votes by `created` alone, ties in reverse id order, a gateway that
// serves the pinned votes, and a chain that holds the votes' balances and checks signatures with `verifyTypedData`
const verifyWith = async (
  votes: CastVote[],
  {
    space = SANDBOX,
    messages = messagesOf(votes, space),
    verifyTypedData = validSignaturesExcept(),
    idInLimit = Infinity,
  }: {
    space?: string;
    messages?: ReturnType<typeof messagesOf>;
    verifyTypedData?: PublicClient['verifyTypedData'];
    idInLimit?: number;
  } = {}
) => {
  const own = votes.filter((vote) => vote.proposal === PROPOSAL_ID);
  const scores = [1, 2, 3].map((choice) =>
    own.filter((vote) => vote.row.choice === choice).reduce((total, vote) => total + vote.row.vp, 0)
  );
  const proposal = {
    id: PROPOSAL_ID,
    ipfs: 'bafkreiproposal',
    space: { id: space },
    network: '1',
    type: 'basic',
    state: 'closed',
    title: 'Routine',
    author: AUTHOR,
    labels: ['routine'],
    choices: ['For', 'Against', 'Abstain'],
    start,
    end,
    snapshot: Number(SNAPSHOT),
    created: received,
    votes: own.length,
    scores,
    scores_by_strategy: scores.map((score) => [score]),
    scores_total: scores.reduce((total, score) => total + score, 0),
    scores_state: 'final',
    quorum: 300,
    privacy: '',
    validation: { name: 'any', params: {} },
    strategies: [{ name: 'erc20-balance-of', network: '1', params: { symbol: 'API3', address: API3, decimals: 18 } }],
  };
  const hubData = (query: string, variables: Record<string, any>) => {
    if (query.includes('proposal(id')) return { proposal };
    if (variables.timestamp !== undefined) {
      const atTimestamp = messages
        .filter(
          (message) =>
            message.space === variables.space &&
            message.timestamp === variables.timestamp &&
            message.mci > variables.mci
        )
        .sort((a, b) => a.mci - b.mci)
        .slice(0, variables.first);
      return { messages: atTimestamp.map(({ id, mci }) => ({ id, mci })) };
    }
    if (variables.ids !== undefined) {
      const ids = new Set<string>(variables.ids);
      const listed = votes.filter((vote) => vote.proposal === variables.proposal && ids.has(vote.row.id));
      return { votes: listed.slice(0, variables.first).map((vote) => vote.row) };
    }
    if (variables.created !== undefined) {
      const page = own
        .map((vote) => vote.row)
        .filter((row) => row.created >= variables.created)
        .sort((a, b) => a.created - b.created || b.id.localeCompare(a.id))
        .slice(0, variables.first);
      return { votes: page };
    }
    if (variables.id !== undefined) return { messages: [{ mci: PROPOSAL_MCI, timestamp: received }] };
    return { messages: [{ mci: PROPOSAL_MCI - 1, timestamp: received - SLOT }] };
  };
  const pinned = new Map(votes.map((vote) => [vote.row.ipfs, vote.pinned]));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith(IPFS_GATEWAY_URL)) return new Response(pinned.get(url.slice(IPFS_GATEWAY_URL.length)));
    if (url !== 'https://hub.snapshot.org/graphql') throw new Error(`Unexpected request to ${url}`);
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, any> };
    if (variables.ids?.length > idInLimit) {
      const message = `The \`id_in\` argument must not be greater than ${idInLimit}`;
      return Response.json({ errors: [{ message }], data: null }, { status: 500 });
    }
    return Response.json({ data: hubData(query, variables) });
  });
  const balances = new Map([[AUTHOR, tokens(10)], ...votes.map((vote) => [vote.row.voter, vote.balance] as const)]);
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      timestamp: BigInt(received) + (blockNumber - SNAPSHOT) * BigInt(SLOT),
    }),
    multicall: async ({ contracts }: { contracts: { args: [Address] }[] }) =>
      contracts.map(({ args: [account] }) => balances.get(account) ?? 0n),
    verifyTypedData,
  } as unknown as PublicClient;
  return verifyProposal(client, PROPOSAL_ID, mkdtempSync(join(tmpdir(), 'vote-verification-')), new Date());
};

describe('verifyProposal', () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a signature ending in an empty ERC-8010 suffix, which viem throws on, as the vote's problem", async () => {
    const sig = `0x${'00'.repeat(64)}${'8010'.repeat(16)}`;
    // viem throws on the suffix before it calls the RPC, so the test makes no request
    const { verifyTypedData } = createPublicClient({ chain: mainnet, transport: http() });
    const verification = await verifyWith([castVote(bob, 2, 1n, { sig })], { verifyTypedData });

    expect(verification.voters.map((voter) => voter.problems)).toEqual([
      ['pinned vote not checked: AbiParameters.ZeroDataError: Cannot decode zero data ("0x") with ABI parameters.'],
    ]);
  });

  it('keeps the RPC URL out of the problem', async () => {
    const verifyTypedData = async () => {
      throw new HttpRequestError({ url: 'https://rpc.example/v2/api-key', status: 429 });
    };
    const verification = await verifyWith([castVote(alice, 1, tokens(400))], { verifyTypedData });

    expect(verification.voters.map((voter) => voter.problems)).toEqual([
      ['pinned vote not checked: HttpRequestError: HTTP request failed.'],
    ]);
  });

  it('lists every vote when a full page of votes shares one timestamp', async () => {
    const votes = tiedVotes(1000);
    const verification = await verifyWith(votes);

    expect(verification.voters.map((voter) => voter.vote.id)).toEqual(idsInOrder(votes));
    expect(verification.problems).toEqual([]);
  });

  it('lists every vote of a full page sharing one timestamp from a hub that looks up at most 100 ids at a time', async () => {
    const votes = tiedVotes(1000);
    // The live hub answers an `id_in` filter of more than 100 ids with status 500
    const verification = await verifyWith(votes, { idInLimit: 100 });

    expect(verification.voters.map((voter) => voter.vote.id)).toEqual(idsInOrder(votes));
    expect(verification.problems).toEqual([]);
  });

  it('lists every vote of a full page sharing one timestamp from a hub that takes 100 ids at most', async () => {
    const votes = tiedVotes(1001);
    // Ten full lookups of 100 ids, and one for the vote left over
    const verification = await verifyWith(votes, { idInLimit: 100 });

    expect(verification.voters.map((voter) => voter.vote.id)).toEqual(idsInOrder(votes));
    expect(verification.problems).toEqual([]);
  });

  it('reads the vote messages of the timestamp a page at a time, leaving out other proposals and replaced votes', async () => {
    const votes = Array.from({ length: 1001 }, (_, index) => castVote(voterAt(index), 1, 0n, { created: tied }));
    const elsewhere = castVote(voterAt(1001), 1, 0n, { created: tied, proposal: OTHER_PROPOSAL_ID });
    const replaced = castVote(voterAt(1002), 1, 0n, { created: tied });
    // Received in the order the hub lists them, so the vote its page of 1000 leaves out is named on the last page
    const listed = [...votes].sort((a, b) => b.row.id.localeCompare(a.row.id));
    const verification = await verifyWith([...votes, elsewhere], {
      messages: messagesOf([elsewhere, replaced, ...listed]),
    });

    expect(verification.voters.map((voter) => voter.vote.id)).toEqual(idsInOrder(votes));
    expect(verification.problems).toEqual([]);
  });

  it('pages through 999 votes sharing one timestamp', async () => {
    const votes = [
      ...Array.from({ length: 999 }, (_, index) => castVote(voterAt(index), 1, 0n, { created: tied })),
      ...Array.from({ length: 1001 }, (_, index) =>
        castVote(voterAt(999 + index), 1, 0n, { created: tied + 1 + index })
      ),
    ];
    const verification = await verifyWith(votes);

    expect(verification.voters.map((voter) => voter.vote.id)).toEqual(idsInOrder(votes));
    expect(verification.problems).toEqual([]);
  });
});
