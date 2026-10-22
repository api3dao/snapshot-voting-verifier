import { type Address, type Hex, stringToHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

// The mainnet fixture the vote verification tests run against: test-only wallets on the Snapshot test space. The
// mnemonic is deliberately public, the accounts hold dust and exist only so the state is reproducible from this file.
export const FIXTURE_MNEMONIC = 'boy company stick soul innocent armor birth team flee wreck flag custom';

export const SPACE = 'testing-new-d-ignore-xyz-a.eth';
export const SPACE_ID: Hex = stringToHex(SPACE, { size: 32 });
export const GLOBAL_ID: Hex = `0x${'0'.repeat(64)}`;

export const AGENT: Address = '0x966ee27c6b758dc9c820b578b7fdab006ed41151';
export const API3: Address = '0x0b38210ea11411557c13457d4da7dc6ea731b88a';
export const POOL: Address = '0x6dd655f10d4b9e242ae186d9050b68f725c76d76';
export const MORPHO: Address = '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb';
export const REGISTRY: Address = '0x469788fe6e9e9681c6ebf3bf78e7fd26fc015446';
export const USDC: Address = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

// The test Morpho market with API3 as collateral, see snapshot/README.md
export const MORPHO_MARKET = {
  loanToken: USDC,
  collateralToken: API3,
  oracle: '0x85e455ee98728569a6062f9c4f0c6feb8fc07f6c' as Address,
  irm: '0x870ac11d48b15db9a138cf899d20f13f79ba00bc' as Address,
  lltv: 625_000_000_000_000_000n,
};
export const MORPHO_MARKET_ID: Hex = '0x95f4872c0af0fb4528bed7ddd34eec322abe8c5478b5f37f936be9e51c0d1e5e';

// The Kabu API3/USDC market the production strategies read, live since block 25981397. The id recomputes from
// keccak256(abi.encode(params)) and Morpho's idToMarketParams returns these parameters for it
export const KABU_MARKET = {
  loanToken: USDC,
  collateralToken: API3,
  oracle: '0xeeaae0152e82a91870590a01604a51ceb6070321' as Address,
  irm: '0x870ac11d48b15db9a138cf899d20f13f79ba00bc' as Address,
  lltv: 625_000_000_000_000_000n,
};
export const KABU_MARKET_ID: Hex = '0x70dfbd2705d10d5dfb4d89e07e2bb860b5a624ce2f97e209ab9f5308bf6c67a1';

// Filled in after the mainnet deployment
export const VESTING: Address | null = '0x9e4be3511798df134349bcfe54c270cc7330fb3a';
export const PROPOSAL_ID: string | null = '0x29b6b33ee2cfac8521f0d24bcf54377cd08e5f4b1bc0529b60ad9da7070fbd87';

export const fixtureAccount = (index: number) => mnemonicToAccount(FIXTURE_MNEMONIC, { accountIndex: index });

// Every amount in wei of API3, distinct so a sum reveals its parts. The gas budget is what the wallet's own
// transactions need, its ETH funding is derived from it and the fee level at run time
export const WALLETS = {
  staker: {
    index: 0,
    address: fixtureAccount(0).address.toLowerCase() as Address,
    gasBudget: 1_100_000n,
    liquid: 1100n,
    deposit: 3000n,
    stake: 2000n,
    unstake: 500n,
    morpho: 700n,
    kabu: 300n,
  },
  delegator: {
    index: 1,
    address: fixtureAccount(1).address.toLowerCase() as Address,
    gasBudget: 400_000n,
    liquid: 210n,
    deposit: 400n,
    stake: 400n,
  },
  globalDelegator: {
    index: 2,
    address: fixtureAccount(2).address.toLowerCase() as Address,
    gasBudget: 150_000n,
    liquid: 30n,
  },
  overrider: {
    index: 3,
    address: fixtureAccount(3).address.toLowerCase() as Address,
    gasBudget: 150_000n,
    liquid: 50n,
  },
  chained: {
    index: 4,
    address: fixtureAccount(4).address.toLowerCase() as Address,
    gasBudget: 150_000n,
    liquid: 90n,
  },
};

export const VESTING_AMOUNT = 7n;
// Starts far in the future so nothing becomes withdrawable and the fixture stays put for years
export const VESTING_START_DELAY_SECONDS = 10n * 365n * 24n * 60n * 60n;
export const VESTING_DURATION_SECONDS = 365n * 24n * 60n * 60n;
