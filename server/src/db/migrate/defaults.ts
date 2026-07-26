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
import * as codexOauthAccounts from '../migrations/20260722_000019_codex_oauth_accounts.js';
import * as codexModels from '../migrations/20260723_000020_codex_models.js';
import * as addCodexModel from '../migrations/20260723_000021_add_codex_model.js';
import * as codexModelAndBilling from '../migrations/20260723_000022_codex_model_and_billing.js';
import * as consumerApiKeyType from '../migrations/20260723_000023_consumer_api_key_type.js';
import * as modelUpstreamId from '../migrations/20260723_000024_model_upstream_id.js';
import * as codexOauthAccountModels from '../migrations/20260723_000025_codex_oauth_account_models.js';
import * as codexUsageStats from '../migrations/20260723_000026_codex_usage_stats.js';
import * as codexUsageRecords from '../migrations/20260723_000027_codex_usage_records.js';
import * as codexAccountQuota from '../migrations/20260723_000028_codex_account_quota.js';
import * as freeModelAccess from '../migrations/20260723_000029_free_model_access.js';
import * as resourceArchitecture from '../migrations/20260724_000030_resource_architecture.js';
import * as resourceProductsOrders from '../migrations/20260725_000031_resource_products_orders.js';
import * as resourceGroupingStatus from '../migrations/20260725_000032_resource_grouping_status.js';
import * as resourceSubpoolActivation from '../migrations/20260725_000033_resource_subpool_activation.js';
import * as resourceAdminAudit from '../migrations/20260725_000034_resource_admin_audit.js';
import * as resourceWalletPurchase from '../migrations/20260725_000035_resource_wallet_purchase.js';
import * as resourceSubpoolEntitlementFreeze from '../migrations/20260725_000036_resource_subpool_entitlement_freeze.js';
import * as resourceScopeIsolation from '../migrations/20260725_000037_resource_scope_isolation.js';
import * as codexAccountSoftDelete from '../migrations/20260725_000038_codex_account_soft_delete.js';
import * as resourcePartialSettlement from '../migrations/20260725_000039_resource_partial_settlement.js';
import * as resourceOperationalAlerts from '../migrations/20260725_000040_resource_operational_alerts.js';
import * as codexAliasTools from '../migrations/20260725_000041_codex_alias_tools.js';
import * as resourceMemberMultipleKeys from '../migrations/20260725_000042_resource_member_multiple_keys.js';
import * as resourcePointsPolicy from '../migrations/20260725_000043_resource_points_policy.js';
import * as resourceCachedPoints from '../migrations/20260725_000044_resource_cached_points.js';
import * as resourceQuotaStages from '../migrations/20260726_000045_resource_quota_stages.js';
import * as resourceQuotaPhases from '../migrations/20260726_000046_resource_quota_phases.js';
import * as consumerApiKeyCiphertext from '../migrations/20260726_000047_consumer_api_key_ciphertext.js';
import * as codexCachedBilling from '../migrations/20260726_000048_codex_cached_billing.js';
import * as siteNotifications from '../migrations/20260726_000049_site_notifications.js';

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
export const CODEX_OAUTH_ACCOUNTS_FILENAME = '20260722_000019_codex_oauth_accounts.ts';
export const ADD_CODEX_MODEL_FILENAME = '20260723_000021_add_codex_model.ts';
export const CODEX_MODELS_FILENAME = '20260723_000020_codex_models.ts';
export const CODEX_MODEL_AND_BILLING_FILENAME = '20260723_000022_codex_model_and_billing.ts';
export const CONSUMER_API_KEY_TYPE_FILENAME = '20260723_000023_consumer_api_key_type.ts';
export const MODEL_UPSTREAM_ID_FILENAME = '20260723_000024_model_upstream_id.ts';
export const CODEX_OAUTH_ACCOUNT_MODELS_FILENAME = '20260723_000025_codex_oauth_account_models.ts';
export const CODEX_USAGE_STATS_FILENAME = '20260723_000026_codex_usage_stats.ts';
export const CODEX_USAGE_RECORDS_FILENAME = '20260723_000027_codex_usage_records.ts';
export const CODEX_ACCOUNT_QUOTA_FILENAME = '20260723_000028_codex_account_quota.ts';
export const FREE_MODEL_ACCESS_FILENAME = '20260723_000029_free_model_access.ts';
export const RESOURCE_ARCHITECTURE_FILENAME = '20260724_000030_resource_architecture.ts';
export const RESOURCE_PRODUCTS_ORDERS_FILENAME = '20260725_000031_resource_products_orders.ts';
export const RESOURCE_GROUPING_STATUS_FILENAME = '20260725_000032_resource_grouping_status.ts';
export const RESOURCE_SUBPOOL_ACTIVATION_FILENAME = '20260725_000033_resource_subpool_activation.ts';
export const RESOURCE_ADMIN_AUDIT_FILENAME = '20260725_000034_resource_admin_audit.ts';
export const RESOURCE_WALLET_PURCHASE_FILENAME = '20260725_000035_resource_wallet_purchase.ts';
export const RESOURCE_SUBPOOL_ENTITLEMENT_FREEZE_FILENAME = '20260725_000036_resource_subpool_entitlement_freeze.ts';
export const RESOURCE_SCOPE_ISOLATION_FILENAME = '20260725_000037_resource_scope_isolation.ts';
export const CODEX_ACCOUNT_SOFT_DELETE_FILENAME = '20260725_000038_codex_account_soft_delete.ts';
export const RESOURCE_PARTIAL_SETTLEMENT_FILENAME = '20260725_000039_resource_partial_settlement.ts';
export const RESOURCE_OPERATIONAL_ALERTS_FILENAME = '20260725_000040_resource_operational_alerts.ts';
export const CODEX_ALIAS_TOOLS_FILENAME = '20260725_000041_codex_alias_tools.ts';
export const RESOURCE_MEMBER_MULTIPLE_KEYS_FILENAME = '20260725_000042_resource_member_multiple_keys.ts';
export const RESOURCE_POINTS_POLICY_FILENAME = '20260725_000043_resource_points_policy.ts';
export const RESOURCE_CACHED_POINTS_FILENAME = '20260725_000044_resource_cached_points.ts';
export const RESOURCE_QUOTA_STAGES_FILENAME = '20260726_000045_resource_quota_stages.ts';
export const RESOURCE_QUOTA_PHASES_FILENAME = '20260726_000046_resource_quota_phases.ts';
export const CONSUMER_API_KEY_CIPHERTEXT_FILENAME = '20260726_000047_consumer_api_key_ciphertext.ts';
export const CODEX_CACHED_BILLING_FILENAME = '20260726_000048_codex_cached_billing.ts';
export const SITE_NOTIFICATIONS_FILENAME = '20260726_000049_site_notifications.ts';

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
  { filename: CODEX_OAUTH_ACCOUNTS_FILENAME, module: codexOauthAccounts },
  { filename: CODEX_MODELS_FILENAME, module: codexModels },
  { filename: ADD_CODEX_MODEL_FILENAME, module: addCodexModel },
  { filename: CODEX_MODEL_AND_BILLING_FILENAME, module: codexModelAndBilling },
  { filename: CONSUMER_API_KEY_TYPE_FILENAME, module: consumerApiKeyType },
  { filename: MODEL_UPSTREAM_ID_FILENAME, module: modelUpstreamId },
  { filename: CODEX_OAUTH_ACCOUNT_MODELS_FILENAME, module: codexOauthAccountModels },
  { filename: CODEX_USAGE_STATS_FILENAME, module: codexUsageStats },
  { filename: CODEX_USAGE_RECORDS_FILENAME, module: codexUsageRecords },
  { filename: CODEX_ACCOUNT_QUOTA_FILENAME, module: codexAccountQuota },
  { filename: FREE_MODEL_ACCESS_FILENAME, module: freeModelAccess },
  { filename: RESOURCE_ARCHITECTURE_FILENAME, module: resourceArchitecture },
  { filename: RESOURCE_PRODUCTS_ORDERS_FILENAME, module: resourceProductsOrders },
  { filename: RESOURCE_GROUPING_STATUS_FILENAME, module: resourceGroupingStatus },
  { filename: RESOURCE_SUBPOOL_ACTIVATION_FILENAME, module: resourceSubpoolActivation },
  { filename: RESOURCE_ADMIN_AUDIT_FILENAME, module: resourceAdminAudit },
  { filename: RESOURCE_WALLET_PURCHASE_FILENAME, module: resourceWalletPurchase },
  { filename: RESOURCE_SUBPOOL_ENTITLEMENT_FREEZE_FILENAME, module: resourceSubpoolEntitlementFreeze },
  { filename: RESOURCE_SCOPE_ISOLATION_FILENAME, module: resourceScopeIsolation },
  { filename: CODEX_ACCOUNT_SOFT_DELETE_FILENAME, module: codexAccountSoftDelete },
  { filename: RESOURCE_PARTIAL_SETTLEMENT_FILENAME, module: resourcePartialSettlement },
  { filename: RESOURCE_OPERATIONAL_ALERTS_FILENAME, module: resourceOperationalAlerts },
  { filename: CODEX_ALIAS_TOOLS_FILENAME, module: codexAliasTools },
  { filename: RESOURCE_MEMBER_MULTIPLE_KEYS_FILENAME, module: resourceMemberMultipleKeys },
  { filename: RESOURCE_POINTS_POLICY_FILENAME, module: resourcePointsPolicy },
  { filename: RESOURCE_CACHED_POINTS_FILENAME, module: resourceCachedPoints },
  { filename: RESOURCE_QUOTA_STAGES_FILENAME, module: resourceQuotaStages },
  { filename: RESOURCE_QUOTA_PHASES_FILENAME, module: resourceQuotaPhases },
  { filename: CONSUMER_API_KEY_CIPHERTEXT_FILENAME, module: consumerApiKeyCiphertext },
  { filename: CODEX_CACHED_BILLING_FILENAME, module: codexCachedBilling },
  { filename: SITE_NOTIFICATIONS_FILENAME, module: siteNotifications },
];
