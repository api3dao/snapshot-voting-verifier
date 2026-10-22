import { existsSync } from 'node:fs';

let loaded = false;

// secrets.env is optional: ETH_RPC_URL for an archive node of your own and SNAPSHOT_API_KEY for the hub, see
// secrets.example.env. Loaded once, the environment itself takes precedence
export const loadSecrets = () => {
  if (loaded) return;
  loaded = true;
  if (existsSync('secrets.env')) process.loadEnvFile('secrets.env');
};
