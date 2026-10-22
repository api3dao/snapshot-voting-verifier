import { parseAbi } from 'viem';

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

export const poolAbi = parseAbi([
  'function depositRegular(uint256 amount)',
  'function stake(uint256 amount)',
  'function scheduleUnstake(uint256 amount)',
  'function delegateVotingPower(address delegate)',
  'function userStake(address user) view returns (uint256)',
  'function userVotingPower(address user) view returns (uint256)',
  'function totalStake() view returns (uint256)',
  'function totalShares() view returns (uint256)',
  'function userDelegate(address user) view returns (address)',
  'function users(address user) view returns (uint256 unstaked, uint256 vesting, uint256 unstakeAmount, uint256 unstakeShares, uint256 unstakeScheduledFor, uint256 lastDelegationUpdateTimestamp, uint256 lastProposalTimestamp)',
]);

export const morphoAbi = parseAbi([
  'struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }',
  'function supplyCollateral(MarketParams marketParams, uint256 assets, address onBehalf, bytes data)',
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
]);

export const registryAbi = parseAbi([
  'function setDelegate(bytes32 id, address delegate)',
  'function delegation(address delegator, bytes32 id) view returns (address)',
]);

export const vestingAbi = parseAbi([
  'function beneficiary() view returns (address)',
  'function amount() view returns (uint256)',
  'function snapshotSpaceId() view returns (bytes32)',
]);
