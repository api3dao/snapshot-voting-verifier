// Relative, so it holds for dust-sized fixture powers as well as millions of tokens. Snapshot sums floats per
// strategy and per delegator in its own order, which leaves noise around the last digit and nothing more
export const SCORE_TOLERANCE = 1e-9;

export const scoresMatch = (expected: number, actual: number) =>
  Math.abs(expected - actual) <= SCORE_TOLERANCE * Math.max(Math.abs(expected), Math.abs(actual));

// Basic and single-choice proposals carry the 1-based index of the chosen option
export const parseBasicChoice = (choice: unknown, choicesCount: number) => {
  if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 1 || choice > choicesCount) {
    throw new Error(`Choice ${JSON.stringify(choice)} is not a valid option index`);
  }
  return choice;
};

export const tallyBasic = (votes: { choice: number; score: number }[], choicesCount: number) => {
  const totals = Array.from<number>({ length: choicesCount }).fill(0);
  for (const vote of votes) totals[vote.choice - 1] += vote.score;
  return totals;
};
