import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { type HubProposal, type HubSettingsMessage, fetchSettingsBefore } from './hub';
import { fetchSettingsObject } from './ipfs';
import { strategySchema } from './schemas';

const settingsSchema = z.looseObject({
  network: z.string(),
  strategies: z.array(strategySchema),
  voting: z.looseObject({ privacy: z.string().optional() }),
  voteValidation: z.object({ name: z.string(), params: z.record(z.string(), z.unknown()).optional() }).optional(),
});

export type SpaceSettings = z.infer<typeof settingsSchema>;

export const parseSettings = (json: string) => settingsSchema.parse(JSON.parse(json));

// The settings the space has to run, as its controller signed them. api3-eth-settings.json is a copy of the file the
// Vault Safe signed for api3.eth, a change to the space's settings is a change of the rules and lands here too. The
// sandbox has no pinned settings, they were re-signed throughout the rehearsals
export const PINNED_SETTINGS: Record<string, SpaceSettings> = {
  'api3.eth': parseSettings(readFileSync(join(__dirname, 'api3-eth-settings.json'), 'utf8')),
};

// The fields that decide who may post and vote, with what power, how the result is counted and who can change or
// moderate the space. The rest (name, about, avatar, socials, categories, treasuries) is how the space presents itself
export const GOVERNANCE_FIELDS = [
  'network',
  'strategies',
  'voting',
  'validation',
  'voteValidation',
  'filters',
  'admins',
  'moderators',
  'members',
] as const;

// The governance fields whose values differ, key order aside
export const settingsDifferences = (pinned: SpaceSettings, actual: SpaceSettings) =>
  GOVERNANCE_FIELDS.filter((field) => !isDeepStrictEqual(pinned[field], actual[field]));

// The settings message the hub received last before the message numbered `mci`, or the latest one, with the settings
// it carries, read from the object the hub pinned under its CID
export const fetchSettingsInForce = async (space: string, mci?: number) => {
  const message = await fetchSettingsBefore(space, mci);
  if (!message) return;
  const object = await fetchSettingsObject(message.ipfs);
  if (object.hash !== message.id || object.data.message.space !== space) {
    throw new Error(`The object pinned for settings message ${message.id} is not that message`);
  }
  return { message, settings: parseSettings(object.data.message.settings) };
};

const formatDate = (timestamp: number) => new Date(timestamp * 1000).toISOString();

// The hub serves a validation without params as an empty object
const sameValidation = (
  proposal: HubProposal['validation'],
  pinned: SpaceSettings['voteValidation'] = { name: 'any' }
) => proposal.name === pinned.name && isDeepStrictEqual(proposal.params ?? {}, pinned.params ?? {});

// `inForce` is the content of the settings message in force when the hub received the proposal, `changes` the
// settings messages the hub received after it that may have been received before the vote closed
export const settingsProblems = (
  pinned: SpaceSettings,
  proposal: Pick<HubProposal, 'network' | 'strategies' | 'privacy' | 'validation'>,
  inForce: SpaceSettings | undefined,
  changes: HubSettingsMessage[]
) => {
  const problems: string[] = [];
  if (inForce) {
    const differences = settingsDifferences(pinned, inForce);
    if (differences.length > 0) {
      problems.push(`space settings in force at posting differ from the pinned ones in ${differences.join(', ')}`);
    }
  } else {
    problems.push('the hub has no settings message for the space before the proposal');
  }
  // What Snapshot copied onto the proposal when it received it, the settings its votes are taken under
  if (proposal.network !== pinned.network) {
    problems.push(`proposal network ${proposal.network}, ${pinned.network} pinned`);
  }
  if (!isDeepStrictEqual(proposal.strategies, pinned.strategies)) {
    problems.push('proposal strategies differ from the pinned ones');
  }
  // `any` lets the author choose, anything else is what every proposal gets, none being the empty string
  const privacy = pinned.voting.privacy ?? '';
  if (privacy !== 'any' && proposal.privacy !== privacy) {
    problems.push(`proposal privacy "${proposal.privacy}", "${privacy}" pinned`);
  }
  if (!sameValidation(proposal.validation, pinned.voteValidation)) {
    problems.push(`proposal vote validation ${proposal.validation.name} differs from the pinned one`);
  }
  for (const change of changes) {
    problems.push(
      `space settings changed while voting was open, message ${change.id} signed ${formatDate(change.timestamp)}`
    );
  }
  return problems;
};
