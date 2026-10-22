import { type Address, type AbiFunction } from 'viem';
import { z } from 'zod';

export const addressSchema = z
  .string()
  .regex(/^0x[\dA-Fa-f]{40}$/)
  .transform((value) => value.toLowerCase() as Address);

export const strategySchema = z.strictObject({
  name: z.string(),
  network: z.string().optional(),
  params: z.record(z.string(), z.unknown()),
});

export type Strategy = z.infer<typeof strategySchema>;

export const erc20BalanceOfParamsSchema = z.strictObject({
  symbol: z.string().optional(),
  address: addressSchema,
  decimals: z.number().int().nonnegative(),
});

const abiParameterSchema = z.strictObject({
  name: z.string(),
  type: z.string(),
  internalType: z.string().optional(),
});

export const contractCallParamsSchema = z.strictObject({
  symbol: z.string().optional(),
  address: addressSchema,
  decimals: z.number().int().nonnegative(),
  args: z.array(z.union([z.string(), z.number()])).optional(),
  output: z.string().optional(),
  methodABI: z
    .strictObject({
      name: z.string(),
      type: z.literal('function'),
      stateMutability: z.string().optional(),
      constant: z.boolean().optional(),
      payable: z.boolean().optional(),
      inputs: z.array(abiParameterSchema),
      outputs: z.array(abiParameterSchema),
    })
    .transform((value) => value as AbiFunction),
});

// The operations of Snapshot's math strategy and the operands they take, one, two or three, in this order
const MATH_OPERATIONS = [
  'square-root',
  'cube-root',
  'min',
  'max',
  'a-if-lt-b',
  'a-if-lte-b',
  'a-if-gt-b',
  'a-if-gte-b',
  'multiply',
  'minus',
  'divide',
] as const;

export type MathOperation = (typeof MATH_OPERATIONS)[number];

const MATH_OPERAND_COUNTS: Record<MathOperation, number> = {
  'square-root': 1,
  'cube-root': 1,
  min: 2,
  max: 2,
  'a-if-lt-b': 3,
  'a-if-lte-b': 3,
  'a-if-gt-b': 3,
  'a-if-gte-b': 3,
  multiply: 2,
  minus: 2,
  divide: 2,
};

const mathOperandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('strategy'), strategy: strategySchema }),
  z.strictObject({ type: z.literal('constant'), value: z.number() }),
]);

export const mathParamsSchema = z
  .strictObject({
    symbol: z.string().optional(),
    operation: z.enum(MATH_OPERATIONS),
    operands: z.array(mathOperandSchema),
  })
  .refine((params) => params.operands.length === MATH_OPERAND_COUNTS[params.operation], {
    message: 'Operand count mismatch',
  });

export const withDelegationParamsSchema = z.strictObject({
  symbol: z.string().optional(),
  delegationSpace: z.string().optional(),
  delegationNetwork: z.string().optional(),
  strategies: z.array(strategySchema),
});
