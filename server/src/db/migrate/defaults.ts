import type { Db } from '../types.js';
import * as legacyBaseline from '../migrations/20260101_000000_legacy_baseline.js';
import * as customProviderModalities from '../migrations/20260627_000001_custom_provider_modalities.js';
import * as catalogModelState from '../migrations/20260627_000002_catalog_model_state.js';
import * as requestAggregates from '../migrations/20260628_120000_request_aggregates.js';
import * as githubGpt41Context from '../migrations/20260630_000001_github_gpt41_context.js';
import * as requestClientInfo from '../migrations/20260706_000001_request_client_info.js';
import * as customModelToolSupport from '../migrations/20260706_000002_custom_model_tool_support.js';
import * as profileChainBackfill from '../migrations/20260714_000001_profile_chain_backfill.js';
import * as consumerApiKeys from '../migrations/20260719_000001_consumer_api_keys.js';
import * as userRoles from '../migrations/20260719_000002_user_roles.js';
import * as consumerRequestIdentity from '../migrations/20260719_000003_consumer_request_identity.js';
import * as userMonthlyTokenLimit from '../migrations/20260719_000004_user_monthly_token_limit.js';
import * as userStatus from '../migrations/20260719_000005_user_status.js';

export interface MigrationModule {
  up(db: Db): void;
  down(db: Db): void;
}

export interface DefaultMigration {
  filename: string;
  module: MigrationModule;
}

export const LEGACY_BASELINE_FILENAME = '20260101_000000_legacy_baseline.ts';
export const CUSTOM_PROVIDER_MODALITIES_FILENAME = '20260627_000001_custom_provider_modalities.ts';
export const CATALOG_MODEL_STATE_FILENAME = '20260627_000002_catalog_model_state.ts';
export const REQUEST_AGGREGATES_FILENAME = '20260628_120000_request_aggregates.ts';
export const GITHUB_GPT41_CONTEXT_FILENAME = '20260630_000001_github_gpt41_context.ts';
export const REQUEST_CLIENT_INFO_FILENAME = '20260706_000001_request_client_info.ts';
export const CUSTOM_MODEL_TOOL_SUPPORT_FILENAME = '20260706_000002_custom_model_tool_support.ts';
export const PROFILE_CHAIN_BACKFILL_FILENAME = '20260714_000001_profile_chain_backfill.ts';
export const CONSUMER_API_KEYS_FILENAME = '20260719_000001_consumer_api_keys.ts';
export const USER_ROLES_FILENAME = '20260719_000002_user_roles.ts';
export const CONSUMER_REQUEST_IDENTITY_FILENAME = '20260719_000003_consumer_request_identity.ts';
export const USER_MONTHLY_TOKEN_LIMIT_FILENAME = '20260719_000004_user_monthly_token_limit.ts';
export const USER_STATUS_FILENAME = '20260719_000005_user_status.ts';

export const DEFAULT_MIGRATIONS: readonly DefaultMigration[] = [
  { filename: LEGACY_BASELINE_FILENAME, module: legacyBaseline },
  { filename: CUSTOM_PROVIDER_MODALITIES_FILENAME, module: customProviderModalities },
  { filename: CATALOG_MODEL_STATE_FILENAME, module: catalogModelState },
  { filename: REQUEST_AGGREGATES_FILENAME, module: requestAggregates },
  { filename: GITHUB_GPT41_CONTEXT_FILENAME, module: githubGpt41Context },
  { filename: REQUEST_CLIENT_INFO_FILENAME, module: requestClientInfo },
  { filename: CUSTOM_MODEL_TOOL_SUPPORT_FILENAME, module: customModelToolSupport },
  { filename: PROFILE_CHAIN_BACKFILL_FILENAME, module: profileChainBackfill },
  { filename: CONSUMER_API_KEYS_FILENAME, module: consumerApiKeys },
  { filename: USER_ROLES_FILENAME, module: userRoles },
  { filename: CONSUMER_REQUEST_IDENTITY_FILENAME, module: consumerRequestIdentity },
  { filename: USER_MONTHLY_TOKEN_LIMIT_FILENAME, module: userMonthlyTokenLimit },
  { filename: USER_STATUS_FILENAME, module: userStatus },
];
