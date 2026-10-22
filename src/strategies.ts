import { type Address, type PublicClient, formatUnits, parseAbi } from 'viem';

import {
  contractCallParamsSchema,
  erc20BalanceOfParamsSchema,
  type MathOperation,
  mathParamsSchema,
  type Strategy,
} from './schemas';

// A strategy's result for one address. Token reads keep the integer and the decimals, a math result is already the
// float Snapshot computed it as
export type BaseScore = { raw: bigint; decimals: number } | { value: number };

// Snapshot turns every strategy result into a float before summing, so mirror that conversion exactly
export const scoreOf = (score: BaseScore) =>
  'value' in score ? score.value : Number.parseFloat(formatUnits(score.raw, score.decimals));

export const sumScores = (scores: BaseScore[]) => {
  let total = 0;
  for (const score of scores) total += scoreOf(score);
  return total;
};

const erc20Abi = parseAbi(['function balanceOf(address account) view returns (uint256)']);

const computeErc20BalanceOf = async (
  client: PublicClient,
  params: unknown,
  addresses: Address[],
  blockNumber: bigint
): Promise<BaseScore[]> => {
  const { address, decimals } = erc20BalanceOfParamsSchema.parse(params);
  const balances = await client.multicall({
    contracts: addresses.map((account) => ({ address, abi: erc20Abi, functionName: 'balanceOf', args: [account] })),
    allowFailure: false,
    blockNumber,
  });
  return balances.map((raw) => ({ raw, decimals }));
};

const toBigInt = (value: unknown, description: string) => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'boolean') return value ? 1n : 0n;
  throw new Error(`${description} returned a non-integer value: ${String(value)}`);
};

const computeContractCall = async (
  client: PublicClient,
  params: unknown,
  addresses: Address[],
  blockNumber: bigint
): Promise<BaseScore[]> => {
  const { address, decimals, args, output, methodABI } = contractCallParamsSchema.parse(params);
  const argTemplates = args ?? ['%{address}'];
  const results = await client.multicall({
    contracts: addresses.map((account) => ({
      address,
      abi: [methodABI],
      functionName: methodABI.name,
      args: argTemplates.map((arg) => (typeof arg === 'string' ? arg.replaceAll('%{address}', account) : arg)),
    })),
    allowFailure: false,
    blockNumber,
  });
  const outputIndex = output ? methodABI.outputs.findIndex((parameter) => parameter.name === output) : -1;
  if (output && outputIndex === -1) throw new Error(`Output ${output} is not among the outputs of ${methodABI.name}`);
  return results.map((result) => {
    const value = methodABI.outputs.length > 1 ? (result as unknown[])[Math.max(outputIndex, 0)] : result;
    return { raw: toBigInt(value, `${methodABI.name} on ${address}`), decimals };
  });
};

// Snapshot's math strategy, operation by operation, on the operands' floats. Same branches, same clamping and the
// same division by zero error, so a result here is what the score API computes
export const applyMathOperation = (operation: MathOperation, operands: number[][]): number[] => {
  const [x, a, b] = operands as [number[], number[], number[]];
  return x.map((score, index) => {
    switch (operation) {
      case 'square-root': {
        return Math.sqrt(score);
      }
      case 'cube-root': {
        return Math.cbrt(score);
      }
      case 'min': {
        return Math.min(score, a[index]!);
      }
      case 'max': {
        return Math.max(score, a[index]!);
      }
      case 'a-if-lt-b': {
        return score < b[index]! ? a[index]! : score;
      }
      case 'a-if-lte-b': {
        return score <= b[index]! ? a[index]! : score;
      }
      case 'a-if-gt-b': {
        return score > b[index]! ? a[index]! : score;
      }
      case 'a-if-gte-b': {
        return score >= b[index]! ? a[index]! : score;
      }
      case 'multiply': {
        return score * a[index]!;
      }
      case 'minus': {
        return score > a[index]! ? score - a[index]! : 0;
      }
      case 'divide': {
        if (a[index] === 0) throw new Error('Cannot divide by zero!');
        return score / a[index]!;
      }
    }
  });
};

const computeMath = async (
  client: PublicClient,
  params: unknown,
  addresses: Address[],
  blockNumber: bigint
): Promise<BaseScore[]> => {
  const { operation, operands } = mathParamsSchema.parse(params);
  const resolved: number[][] = [];
  for (const operand of operands) {
    if (operand.type === 'constant') {
      resolved.push(addresses.map(() => operand.value));
      continue;
    }
    const [scores] = await computeBaseScores(client, [operand.strategy], addresses, blockNumber);
    resolved.push(scores!.map((score) => scoreOf(score)));
  }
  return applyMathOperation(operation, resolved).map((value) => ({ value }));
};

// One score per address for each strategy, in strategy order. Anything but the strategies the space uses fails loudly
export const computeBaseScores = async (
  client: PublicClient,
  strategies: Strategy[],
  addresses: Address[],
  blockNumber: bigint
): Promise<BaseScore[][]> => {
  const scores: BaseScore[][] = [];
  for (const strategy of strategies) {
    switch (strategy.name) {
      case 'erc20-balance-of': {
        scores.push(await computeErc20BalanceOf(client, strategy.params, addresses, blockNumber));
        break;
      }
      case 'contract-call': {
        scores.push(await computeContractCall(client, strategy.params, addresses, blockNumber));
        break;
      }
      case 'math': {
        scores.push(await computeMath(client, strategy.params, addresses, blockNumber));
        break;
      }
      default: {
        throw new Error(`Strategy ${strategy.name} is not supported`);
      }
    }
  }
  return scores;
};
