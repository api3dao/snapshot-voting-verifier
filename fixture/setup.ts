import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { go } from '@api3/promise-utils';
import {
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
} from 'viem';
import { type Account, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

import { erc20Abi, morphoAbi, poolAbi, registryAbi } from './abis';
import {
  AGENT,
  API3,
  GLOBAL_ID,
  KABU_MARKET,
  KABU_MARKET_ID,
  MORPHO,
  MORPHO_MARKET,
  MORPHO_MARKET_ID,
  POOL,
  REGISTRY,
  SPACE_ID,
  VESTING,
  VESTING_AMOUNT,
  WALLETS,
  fixtureAccount,
} from './wallets';

// Puts the fixture wallets into the state the fixture test expects. Every step first checks the chain and is
// skipped when already done, so the script can be rerun after a failure. Against a local fork it is a rehearsal,
// against mainnet it needs --mainnet on top of the URL and every step is broadcast for real.

const { values } = parseArgs({
  options: {
    'rpc-url': { type: 'string' },
    mainnet: { type: 'boolean', default: false },
  },
});
const rpcUrl = values['rpc-url'];
if (!rpcUrl) throw new Error('--rpc-url is required');
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)[/:]/.test(rpcUrl);
if (!isLocal && !values.mainnet) throw new Error('A non-local RPC needs --mainnet to broadcast');

const agentKey = execSync('pass show wallet/agent', { encoding: 'utf8' }).trim() as Hex;
const agent = privateKeyToAccount(agentKey);
if (agent.address.toLowerCase() !== AGENT) throw new Error('The key in pass is not the agent wallet');

const transport = http(rpcUrl, { timeout: 120_000 });
const client: PublicClient = createPublicClient({ chain: mainnet, transport });
const walletOf = (account: Account) => createWalletClient({ account, chain: mainnet, transport });

type Step = { label: string; done: () => Promise<boolean>; run: () => Promise<Hex> };

const send = async (account: Account, request: Parameters<ReturnType<typeof walletOf>['writeContract']>[0]) => {
  await client.simulateContract({ ...request, account } as never);
  return walletOf(account).writeContract(request);
};

const balance = (token: Address, owner: Address) =>
  client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
const allowance = (owner: Address, spender: Address) =>
  client.readContract({ address: API3, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] });
const poolUser = (user: Address) =>
  client.readContract({ address: POOL, abi: poolAbi, functionName: 'users', args: [user] });
const poolStake = (user: Address) =>
  client.readContract({ address: POOL, abi: poolAbi, functionName: 'userStake', args: [user] });
const delegation = async (delegator: Address, id: Hex) => {
  const delegate = await client.readContract({
    address: REGISTRY,
    abi: registryAbi,
    functionName: 'delegation',
    args: [delegator, id],
  });
  return delegate.toLowerCase() as Address;
};
const depositedOf = async (user: Address) => {
  const record = await poolUser(user);
  return record[0];
};
const unstakeAmountOf = async (user: Address) => {
  const record = await poolUser(user);
  return record[2];
};
const collateralOf = async (user: Address, marketId: Hex = MORPHO_MARKET_ID) => {
  const position = await client.readContract({
    address: MORPHO,
    abi: morphoAbi,
    functionName: 'position',
    args: [marketId, user],
  });
  return position[2];
};
const poolDelegateOf = async (user: Address) => {
  const delegate = await client.readContract({
    address: POOL,
    abi: poolAbi,
    functionName: 'userDelegate',
    args: [user],
  });
  return delegate.toLowerCase() as Address;
};
const maxFeePerGas = async () => {
  const fees = await client.estimateFeesPerGas();
  return fees.maxFeePerGas;
};

// Everything the pool holds for the user, whichever of the three buckets it is in
const poolTotal = async (user: Address) =>
  (await depositedOf(user)) + (await unstakeAmountOf(user)) + (await poolStake(user));

// Everything the wallet was given, wherever it sits now. Staking rewards only add to it
const totalHoldings = async (user: Address) =>
  (await balance(API3, user)) +
  (await poolTotal(user)) +
  (await collateralOf(user)) +
  (await collateralOf(user, KABU_MARKET_ID));

const transferApi3 = (to: Address, amount: bigint): Step => ({
  label: `agent sends ${amount} wei API3 to ${to}`,
  done: async () => (await totalHoldings(to)) >= amount,
  run: () => send(agent, { address: API3, abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
});

// A later addition to a wallet that already moved its first transfer on: sent only while the addition has not been
// supplied yet and the liquid balance does not already hold it, so the wallet ends up with the liquid amount the
// tests expect
const topUpApi3 = (to: Address, amount: bigint, liquidAfter: bigint, settled: () => Promise<boolean>): Step => ({
  label: `agent tops ${to} up with ${amount} wei API3`,
  done: async () => (await settled()) || (await balance(API3, to)) >= liquidAfter + amount,
  run: () => send(agent, { address: API3, abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
});

// Twice what the wallet's transactions cost at the current fee level, topped up rather than resent on a rerun
const FUNDING_HEADROOM = 2n;

const fundEth = (to: Address, gasBudget: bigint): Step => {
  const target = async () => gasBudget * (await maxFeePerGas()) * FUNDING_HEADROOM;
  return {
    label: `agent funds ${to} with ETH for ${gasBudget} gas`,
    done: async () => (await client.getBalance({ address: to })) >= (await target()),
    run: async () => {
      const value = (await target()) - (await client.getBalance({ address: to }));
      const gas = await client.estimateGas({ account: agent, to, value });
      console.log(`      sending ${formatEther(value)} ETH`);
      return walletOf(agent).sendTransaction({ to, value, gas });
    },
  };
};

// An allowance is spent by the step after it, so it counts as done once that step is
const approve = (account: Account, spender: Address, amount: bigint, settled: () => Promise<boolean>): Step => ({
  label: `${account.address} approves ${spender} for ${amount} wei API3`,
  done: async () => (await settled()) || (await allowance(account.address, spender)) >= amount,
  run: () => send(account, { address: API3, abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
});

const deposit = (account: Account, amount: bigint): Step => ({
  label: `${account.address} deposits ${amount} wei into the pool`,
  done: async () => (await poolTotal(account.address)) >= amount,
  run: () => send(account, { address: POOL, abi: poolAbi, functionName: 'depositRegular', args: [amount] }),
});

const stake = (account: Account, amount: bigint): Step => ({
  label: `${account.address} stakes ${amount} wei`,
  done: async () => (await poolStake(account.address)) + (await unstakeAmountOf(account.address)) > 0n,
  run: () => send(account, { address: POOL, abi: poolAbi, functionName: 'stake', args: [amount] }),
});

const scheduleUnstake = (account: Account, amount: bigint): Step => ({
  label: `${account.address} schedules an unstake of ${amount} wei`,
  done: async () => (await unstakeAmountOf(account.address)) > 0n,
  run: () => send(account, { address: POOL, abi: poolAbi, functionName: 'scheduleUnstake', args: [amount] }),
});

const delegateInPool = (account: Account, delegate: Address): Step => ({
  label: `${account.address} delegates inside the pool to ${delegate}`,
  done: async () => (await poolDelegateOf(account.address)) === delegate,
  run: () => send(account, { address: POOL, abi: poolAbi, functionName: 'delegateVotingPower', args: [delegate] }),
});

const supplyCollateral = (
  account: Account,
  amount: bigint,
  market: typeof MORPHO_MARKET = MORPHO_MARKET,
  marketId: Hex = MORPHO_MARKET_ID
): Step => ({
  label: `${account.address} supplies ${amount} wei as collateral in Morpho market ${marketId}`,
  done: async () => (await collateralOf(account.address, marketId)) >= amount,
  run: () =>
    send(account, {
      address: MORPHO,
      abi: morphoAbi,
      functionName: 'supplyCollateral',
      args: [market, amount, account.address, '0x'],
    }),
});

const setDelegate = (account: Account, id: Hex, delegate: Address): Step => ({
  label: `${account.address} delegates ${id === GLOBAL_ID ? 'all spaces' : 'the space'} to ${delegate} in the registry`,
  done: async () => (await delegation(account.address, id)) === delegate,
  run: () => send(account, { address: REGISTRY, abi: registryAbi, functionName: 'setDelegate', args: [id, delegate] }),
});

const main = async () => {
  const chainId = await client.getChainId();
  if (chainId !== 1) throw new Error(`RPC serves chain ${chainId}`);
  console.log(
    `${isLocal ? 'Rehearsal on a local fork' : 'MAINNET'} at ${rpcUrl}, block ${await client.getBlockNumber()}`
  );
  console.log(
    `agent ${agent.address}: ${formatEther(await client.getBalance({ address: agent.address }))} ETH, ${await balance(API3, agent.address)} wei API3`
  );

  const staker = fixtureAccount(WALLETS.staker.index);
  const delegator = fixtureAccount(WALLETS.delegator.index);
  const globalDelegator = fixtureAccount(WALLETS.globalDelegator.index);
  const overrider = fixtureAccount(WALLETS.overrider.index);
  const chained = fixtureAccount(WALLETS.chained.index);

  const kabuSupplied = async () => (await collateralOf(staker.address, KABU_MARKET_ID)) >= WALLETS.staker.kabu;
  const steps: Step[] = [
    ...Object.values(WALLETS).map((wallet) => fundEth(wallet.address, wallet.gasBudget)),
    transferApi3(WALLETS.staker.address, WALLETS.staker.liquid + WALLETS.staker.deposit + WALLETS.staker.morpho),
    transferApi3(WALLETS.delegator.address, WALLETS.delegator.liquid + WALLETS.delegator.deposit),
    transferApi3(WALLETS.globalDelegator.address, WALLETS.globalDelegator.liquid),
    transferApi3(WALLETS.overrider.address, WALLETS.overrider.liquid),
    transferApi3(WALLETS.chained.address, WALLETS.chained.liquid),
    approve(
      staker,
      POOL,
      WALLETS.staker.deposit,
      async () => (await poolTotal(staker.address)) >= WALLETS.staker.deposit
    ),
    deposit(staker, WALLETS.staker.deposit),
    stake(staker, WALLETS.staker.stake),
    scheduleUnstake(staker, WALLETS.staker.unstake),
    delegateInPool(staker, WALLETS.delegator.address),
    approve(
      staker,
      MORPHO,
      WALLETS.staker.morpho,
      async () => (await collateralOf(staker.address)) >= WALLETS.staker.morpho
    ),
    supplyCollateral(staker, WALLETS.staker.morpho),
    // The real market the production strategies read, so one wallet holds API3 in every place at once
    topUpApi3(staker.address, WALLETS.staker.kabu, WALLETS.staker.liquid, kabuSupplied),
    approve(staker, MORPHO, WALLETS.staker.kabu, kabuSupplied),
    supplyCollateral(staker, WALLETS.staker.kabu, KABU_MARKET, KABU_MARKET_ID),
    approve(
      delegator,
      POOL,
      WALLETS.delegator.deposit,
      async () => (await poolTotal(delegator.address)) >= WALLETS.delegator.deposit
    ),
    deposit(delegator, WALLETS.delegator.deposit),
    stake(delegator, WALLETS.delegator.stake),
    setDelegate(delegator, SPACE_ID, AGENT),
    setDelegate(globalDelegator, GLOBAL_ID, WALLETS.staker.address),
    setDelegate(overrider, GLOBAL_ID, AGENT),
    setDelegate(overrider, SPACE_ID, WALLETS.staker.address),
    setDelegate(chained, SPACE_ID, WALLETS.delegator.address),
  ];

  // The fixture vesting was deployed once and is never deployed again, see VESTING in wallets.ts for what it is to
  // the tests. Here it only has to exist and hold its amount
  if (!VESTING) throw new Error('The fixture vesting is not recorded');
  const vestingCode = await client.getCode({ address: VESTING });
  if (!vestingCode || vestingCode === '0x') throw new Error(`No code at the recorded vesting address ${VESTING}`);
  for (const step of steps) {
    // Public endpoints rate-limit bursts, so a step is retried as a whole and re-checks the chain before resending
    const outcome = await go(
      async () => {
        if (await step.done()) return null;
        const hash = await step.run();
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error(`${step.label} reverted in ${hash}`);
        return { hash, receipt };
      },
      { retries: 5, delay: { type: 'static', delayMs: 5000 } }
    );
    if (!outcome.success) throw outcome.error;
    if (!outcome.data) {
      console.log(`skip  ${step.label}`);
      continue;
    }
    const { hash, receipt } = outcome.data;
    console.log(`done  ${step.label} (${hash}, ${receipt.gasUsed} gas)`);
  }
  if ((await balance(API3, VESTING)) < VESTING_AMOUNT) {
    const fund = transferApi3(VESTING, VESTING_AMOUNT);
    const hash = await fund.run();
    await client.waitForTransactionReceipt({ hash });
    console.log(`done  ${fund.label} (${hash})`);
  }

  console.log('\nState:');
  for (const [name, wallet] of Object.entries(WALLETS)) {
    console.log(
      `${name} ${wallet.address}: liquid ${await balance(API3, wallet.address)}, deposited ${await depositedOf(wallet.address)}, staked ${await poolStake(wallet.address)}, unstaking ${await unstakeAmountOf(wallet.address)}, morpho ${await collateralOf(wallet.address)}, kabu ${await collateralOf(wallet.address, KABU_MARKET_ID)}, delegation space ${await delegation(wallet.address, SPACE_ID)} global ${await delegation(wallet.address, GLOBAL_ID)}, eth ${formatEther(await client.getBalance({ address: wallet.address }))}`
    );
  }
  console.log(
    `vesting ${VESTING}: liquid ${await balance(API3, VESTING)}, delegation space ${await delegation(VESTING, SPACE_ID)}`
  );
  console.log(
    `agent ${agent.address}: liquid ${await balance(API3, agent.address)}, ${formatEther(await client.getBalance({ address: agent.address }))} ETH`
  );
};

void main();
