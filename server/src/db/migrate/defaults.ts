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
import * as emailVerificationCodes from '../migrations/20260719_000006_email_verification_codes.js';
import * as passwordResetCodes from '../migrations/20260719_000007_password_reset_codes.js';
import * as consumerApiKeyEnabled from '../migrations/20260719_000008_consumer_api_key_enabled.js';
import * as billingSystem from '../migrations/20260719_000009_billing_system.js';
import * as walletReservations from '../migrations/20260719_000010_wallet_reservations.js';
import * as rechargeOrders from '../migrations/20260720_000011_recharge_orders.js';
import * as platformSettings from '../migrations/20260720_000012_platform_settings.js';
import * as bonusWalletTransaction from '../migrations/20260720_000013_bonus_wallet_transaction.js';
import * as playgroundConversations from '../migrations/20260720_000014_playground_conversations.js';
import * as openrouterFreeModels from '../migrations/20260722_000016_openrouter_free_models.js';
import * as openrouterFreeBillingRules from '../migrations/20260722_000017_openrouter_free_billing_rules.js';
import * as siliconflowTestModels from '../migrations/20260722_000018_siliconflow_test_models.js';

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
export const EMAIL_VERIFICATION_CODES_FILENAME = '20260719_000006_email_verification_codes.ts';
export const PASSWORD_RESET_CODES_FILENAME = '20260719_000007_password_reset_codes.ts';
export const CONSUMER_API_KEY_ENABLED_FILENAME = '20260719_000008_consumer_api_key_enabled.ts';
export const BILLING_SYSTEM_FILENAME = '20260719_000009_billing_system.ts';
export const WALLET_RESERVATIONS_FILENAME = '20260719_000010_wallet_reservations.ts';
export const RECHARGE_ORDERS_FILENAME = '20260720_000011_recharge_orders.ts';
export const PLATFORM_SETTINGS_FILENAME = '20260720_000012_platform_settings.ts';
export const BONUS_WALLET_TRANSACTION_FILENAME = '20260720_000013_bonus_wallet_transaction.ts';
export const PLAYGROUND_CONVERSATIONS_FILENAME = '20260720_000014_playground_conversations.ts';
export const OPENROUTER_FREE_MODELS_FILENAME = '20260722_000016_openrouter_free_models.ts';
export const OPENROUTER_FREE_BILLING_RULES_FILENAME = '20260722_000017_openrouter_free_billing_rules.ts';
export const SILICONFLOW_TEST_MODELS_FILENAME = '20260722_000018_siliconflow_test_models.ts';

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
  { filename: EMAIL_VERIFICATION_CODES_FILENAME, module: emailVerificationCodes },
  { filename: PASSWORD_RESET_CODES_FILENAME, module: passwordResetCodes },
  { filename: CONSUMER_API_KEY_ENABLED_FILENAME, module: consumerApiKeyEnabled },
  { filename: BILLING_SYSTEM_FILENAME, module: billingSystem },
  { filename: WALLET_RESERVATIONS_FILENAME, module: walletReservations },
  { filename: RECHARGE_ORDERS_FILENAME, module: rechargeOrders },
  { filename: PLATFORM_SETTINGS_FILENAME, module: platformSettings },
  { filename: BONUS_WALLET_TRANSACTION_FILENAME, module: bonusWalletTransaction },
{ filename: PLAYGROUND_CONVERSATIONS_FILENAME, module: playgroundConversations },
  { filename: OPENROUTER_FREE_MODELS_FILENAME, module: openrouterFreeModels },
  { filename: OPENROUTER_FREE_BILLING_RULES_FILENAME, module: openrouterFreeBillingRules },
  { filename: SILICONFLOW_TEST_MODELS_FILENAME, module: siliconflowTestModels },
];
