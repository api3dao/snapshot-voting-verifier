import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { type Hex, createPublicClient, getAddress, http } from 'viem';
import { type Account, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

import { fetchSpace } from '../src/hub';

import { AGENT, SPACE, WALLETS, fixtureAccount } from './wallets';

// The fixture proposal is posted against a block this far back, inside the verifier's window
const SNAPSHOT_BLOCKS_BACK = 64n;

// Publishes the fixture proposal from the agent wallet and casts the two votes, all as EIP-712 signatures sent to
// Snapshot's sequencer. Gasless, nothing here touches the chain.
//   --create                 publishes the proposal and prints its id
//   --vote <proposal id>     votes For from the agent and Against from the staker

const SEQUENCER_URL = 'https://seq.snapshot.org';
const APP = 'vote-verification';
const CHOICES = ['For', 'Against', 'Abstain'];

const domain = { name: 'snapshot', version: '0.1.4' } as const;

const proposalTypes = {
  Proposal: [
    { name: 'from', type: 'string' },
    { name: 'space', type: 'string' },
    { name: 'timestamp', type: 'uint64' },
    { name: 'type', type: 'string' },
    { name: 'title', type: 'string' },
    { name: 'body', type: 'string' },
    { name: 'discussion', type: 'string' },
    { name: 'choices', type: 'string[]' },
    { name: 'labels', type: 'string[]' },
    { name: 'start', type: 'uint64' },
    { name: 'end', type: 'uint64' },
    { name: 'snapshot', type: 'uint64' },
    { name: 'plugins', type: 'string' },
    { name: 'privacy', type: 'string' },
    { name: 'app', type: 'string' },
  ],
} as const;

const voteTypes = {
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

const { values } = parseArgs({
  options: {
    'rpc-url': { type: 'string' },
    create: { type: 'boolean', default: false },
    vote: { type: 'string' },
  },
});

const send = async (
  account: Account & { signTypedData: NonNullable<Account['signTypedData']> },
  types: typeof proposalTypes | typeof voteTypes,
  message: Record<string, unknown>
) => {
  const primaryType = 'Proposal' in types ? 'Proposal' : 'Vote';
  const sig = await account.signTypedData({ domain, types, primaryType, message } as never);
  const response = await fetch(SEQUENCER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: account.address, sig, data: { domain, types, message } }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Sequencer refused: ${JSON.stringify(body)}`);
  return body;
};

const now = () => Math.floor(Date.now() / 1000);

const main = async () => {
  const agentKey = execSync('pass show wallet/agent', { encoding: 'utf8' }).trim() as Hex;
  const agent = privateKeyToAccount(agentKey);
  if (agent.address.toLowerCase() !== AGENT) throw new Error('The key in pass is not the agent wallet');
  const space = await fetchSpace(SPACE);

  if (values.create) {
    if (!values['rpc-url']) throw new Error('--rpc-url is required to pick the snapshot block');
    const client = createPublicClient({ chain: mainnet, transport: http(values['rpc-url']) });
    const snapshot = (await client.getBlockNumber()) - SNAPSHOT_BLOCKS_BACK;
    const timestamp = now();
    const start = timestamp + 60;
    const message = {
      from: agent.address,
      space: space.id,
      timestamp,
      type: 'basic',
      title: 'Vote verification fixture',
      body: 'Exercises every voting power source and delegation path of the fixture wallets, see api3-dao-migration/vote-verification.',
      discussion: '',
      choices: CHOICES,
      labels: [],
      start,
      end: start + 604_800,
      snapshot: Number(snapshot),
      plugins: '{}',
      privacy: '',
      app: APP,
    };
    const result = await send(agent, proposalTypes, message);
    console.log(`proposal ${String(result.id)} with snapshot block ${snapshot}, record it in fixture/wallets.ts`);
    return;
  }

  if (values.vote) {
    const staker = fixtureAccount(WALLETS.staker.index);
    for (const [account, choice] of [
      [agent, 1],
      [staker, 2],
    ] as const) {
      const message = {
        from: getAddress(account.address),
        space: space.id,
        timestamp: now(),
        proposal: values.vote,
        choice,
        reason: '',
        app: APP,
        metadata: '{}',
      };
      const result = await send(account, voteTypes, message);
      console.log(`${account.address} voted ${CHOICES[choice - 1]}: ${String(result.id)}`);
    }
    return;
  }

  throw new Error('Pass --create or --vote <proposal id>');
};

void main();
