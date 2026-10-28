# Snapshot voting verifier

Recomputes the result of a Snapshot proposal from the chain and says whether the result the Snapshot site shows is the one the signers may execute. Built for the `api3.eth` space, where the multisig signers execute only a result they recomputed, never one read off a website. It works for any space whose strategies it supports.

## What it checks

The governance rules of the DAO migration proposal are the specification. Every check below implements a sentence of that text or guards the recomputation, a difference between the two is a bug in the tool, and `main` is the version the signers run. A failed check ends the run `NOT VERIFIED`, except the two rules that only decide the outcome, noted below.

What the hub has to show:

- The proposal is a `basic` or `single-choice` one, anything else stops the run.
- The hub lists as many votes as it counts for the proposal.
- The hub marks the proposal's scores and every vote's power final.

What the proposal has to satisfy:

- The snapshot block is at most 7,200 blocks, about a day, before the hub received the proposal. The author picks the block and Snapshot only checks that it exists, so without the ceiling a proposer could count balances from years ago. Snapshot's own default, the latest block, is fine, and a Safe that signs with it has a day to collect its signatures and deliver the proposal. Since 2026-10-26 at the latest the hub sets a proposal's `created` to its receipt, moving `start` and `end` with it, when the signed timestamp is earlier, so a backdated signature no longer shortens the voting window. On an older proposal `created` is the signed timestamp, and the receipt is bounded by the signed timestamps of the messages the hub numbered right before the proposal.

What every vote has to satisfy:

- Its pinned object is fetched by the CID the hub lists and the CID is recomputed from the content.
- The pinned object's address and the signed `from` are the voter, the signed space and proposal are the proposal's, and the signed choice and timestamp are the ones the hub lists.
- The EIP-712 types are a vote's, and the hash of the typed data equals the pinned hash and the hub's vote id.
- The signature is valid for the voter, a wallet's directly and a contract's through EIP-1271, checked against the chain's latest state.
- The choice is an option of the proposal and the vote was cast between `start` and `end`.
- The voter's power recomputed at the snapshot block with the proposal's own strategies equals what the hub lists, in total and per strategy, within one part in a billion. Balances and contract state come straight from an archive RPC and delegations from the delegate registry's events, without Snapshot's score API or subgraph in the loop.

What the tally has to satisfy:

- The recomputed powers summed per choice equal the hub's scores, within the same tolerance.

The rules of `api3.eth`, printed next to the tally for the signers to tick and judged on the recomputed result:

- The proposal is a basic one with the choices For, Against and Abstain.
- The proposer held 500,000 API3 at the snapshot block. The sequencer checked the latest block when it received the proposal.
- Voting opened at the proposal's creation on the hub, no delay, and ran seven days.
- The quorum set on the proposal is 10,000,000.
- At least 10,000,000 was cast in favour. Snapshot's own quorum counts every vote, this one only the votes for, and an abstain cast through the API counts for nothing.
- There are more votes for than against.

A failed check among the first four rules means the proposal bypassed the space's settings and is a problem like any other. The last two only decide the outcome, which the report states in one line. The tool does not judge whether a proposal is a rule change or date its 30 days, that is the signers' reading of the content.

Supported: `basic` and `single-choice` proposals, and the strategies `with-delegation` over `erc20-balance-of`, `contract-call` and `math` (Snapshot's operations, in floats, as the score API computes them). Anything else fails loudly rather than being skipped.

## Running

```bash
pnpm install
pnpm run verify --proposal 0x<proposal id>
```

No setup is needed: a rate limited mainnet archive endpoint ships with the tool, shared by everyone who runs it. For anything beyond a look, or for a proposal on another network, copy `secrets.example.env` to `secrets.env` and set `ETH_RPC_URL` to an archive node of your own. `SNAPSHOT_API_KEY` lifts the hub's rate limit on keyless access.

The run ends with `VERIFIED` and exit code 0, or `NOT VERIFIED` and exit code 1 with every problem listed. The vote list is archived under `archive/<proposal id>/` on every run and diffed against the previous archive, so run it at least daily while a vote is open and a vote inserted or removed after the fact shows up. The first run scans the delegate registry from its deployment and caches the events under `cache/`, later runs only fetch what is newer. The scan adapts its block range to what the RPC accepts.

To see what a holder would vote with right now, or at a given block, under a space's current settings:

```bash
pnpm run power --space api3.eth --address 0x<holder> --block 25000000
```

## Mainnet fixture

`fixture/` holds a reproducible set of wallets on the Snapshot test space `testing-new-d-ignore-xyz-a.eth`, one per voting power source and delegation path, plus a vesting contract and a proposal with two votes, all on mainnet. The staker holds API3 in every place the `api3.eth` strategies read, dust collateral in the Kabu API3/USDC market on Morpho included. `test/fixture.e2e.test.ts` checks the recomputation against them from three sides at the proposal's snapshot block: the raw holdings, Snapshot's score API, and the hub's ledger. The mnemonic in `fixture/wallets.ts` is deliberately public, the wallets hold dust.

- `pnpm exec ts-node --transpileOnly fixture/setup.ts --rpc-url <url> --mainnet` is how the state was put in place: it funds the wallets and the vesting and sets every source and delegation. Each step is skipped when the chain already shows it, so rerunning it is harmless. Against a local `anvil --fork-url` it is a dry run. The vesting was deployed once, a DelegatedVesting of the time with the test space id, and is never deployed again.
- `pnpm exec ts-node --transpileOnly fixture/proposal.ts --rpc-url <url> --create` published the proposal from the agent wallet and `--vote <id>` cast the two votes, both gasless signatures sent to the sequencer.

`test/api3-eth-settings.json` is a copy of the settings the `api3.eth` space is created from. `test/production.e2e.test.ts` runs its strategies at a recent block over the fixture wallets, the Vault Safe with its delegated pool stake, a holder with Kabu market collateral and the Treasury and Agent Safes delegated to the dead address, and checks every source against the raw reads and every wallet against the score API.

## Development checks

- `pnpm run tsc`, `pnpm run eslint:check`, `pnpm run prettier:check`
- `pnpm run test` runs the unit tests and, against the RPC, the three end-to-end tests above
