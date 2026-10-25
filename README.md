# Snapshot voting verifier

Recomputes the result of a Snapshot proposal from the chain and says whether the result the Snapshot site shows is the one the signers may execute. Built for the `api3.eth` space, where the multisig signers execute only a result they recomputed, never one read off a website. It works for any space whose strategies it supports.

For every vote it recomputes the voter's power at the proposal's snapshot block with the proposal's own strategies, reading balances and contract state straight from an archive RPC and delegations from the delegate registry's events, without Snapshot's score API or subgraph in the loop. It fetches each vote's pinned object, checks the CID, the EIP-712 hash and the signature against the voter, checks that the vote was cast inside the voting window, sums the choices, and compares everything with the hub.

It also checks the proposal against rules that Snapshot does not enforce:

- The snapshot block is not later than the signed timestamp and at most 300 blocks before the hub received the proposal. The author picks the block and Snapshot only checks that it exists, so without the ceiling a proposer could count balances from years ago. Snapshot's own default, the latest block, is fine.
- The signed timestamp precedes the receipt by at most an hour. Snapshot accepts a timestamp up to six days old, which sets `start` and would shorten the voting window. The receipt is bounded by the signed timestamps of the messages the hub numbered right before the proposal.

For `api3.eth` it then prints the space's rules next to the tally, one line per check for the signers to tick, judged on the recomputed result: the proposal is a basic one, the proposer held 500,000 API3 at the snapshot block, voting opened at the signed timestamp and ran seven days, the quorum set on the proposal is 10,000,000, at least that much was cast in favour (Snapshot's own quorum counts every vote, this one only the votes for, an abstain cast through the API counts for nothing), and there are more votes for than against. A check the proposal bypassed (a proposer below the threshold, a shifted window, a changed quorum) is a problem like any other and the run ends `NOT VERIFIED`. The quorum and the majority only decide the outcome, which the report states in one line.

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

- `pnpm exec ts-node --transpileOnly fixture/setup.ts --rpc-url <url> --mainnet` is how the state was put in place: it deploys the vesting, funds the wallets and sets every source and delegation. Each step is skipped when the chain already shows it, so rerunning it is harmless. Against a local `anvil --fork-url` it is a dry run. The vesting is deployed, its source lives in API3's DAO migration repository and `VESTING_ARTIFACT` names the compiled artifact if it ever has to be deployed again.
- `pnpm exec ts-node --transpileOnly fixture/proposal.ts --rpc-url <url> --create` published the proposal from the agent wallet and `--vote <id>` cast the two votes, both gasless signatures sent to the sequencer.

`test/api3-eth-settings.json` is a copy of the settings the `api3.eth` space is created from. `test/production.e2e.test.ts` runs its strategies at a recent block over the fixture wallets, the Vault Safe with its delegated pool stake and a holder with Kabu market collateral, and checks every source against the raw reads and every wallet against the score API.

## Checks

- `pnpm run tsc`, `pnpm run eslint:check`, `pnpm run prettier:check`
- `pnpm run test` runs the unit tests and, against the RPC, the three end-to-end tests above
