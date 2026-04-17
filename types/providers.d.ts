/**
 * @description 提供商配置的类型定义
 */

/**
 * API 风格类型
 */
export type ApiStyle = 'openai' | 'openai_responses' | 'anthropic' | 'gemini' | 'tavily';

/**
 * 模型获取函数名称
 */
export type FetchModelsFunction =
  | 'fetchOpenAIModels'
  | 'fetchAnthropicModels'
  | 'fetchGoogleModels'
  | 'fetchGitHubModels';

/**
 * 余额检查函数名称
 */
export type BalanceCheckFunction =
  | 'checkOpenRouterBalance'
  | 'checkSiliconFlowBalance'
  | 'checkDeepSeekBalance'
  | 'checkMoonshotBalance'
  | 'checkNewAPIBalance';

/**
 * 单个提供商的元数据配置
 */
export interface ProviderMetadata {
  /** 提供商显示名称 */
  label: string;
  /** 提供商图标（emoji） */
  icon: string;
  /** 是否支持余额查询 */
  hasBalance: boolean;
  /** API 风格类型 */
  apiStyle: ApiStyle;
  /** 默认 API 基础 URL */
  defaultBase: string;
  /** 默认测试模型 */
  defaultModel: string;
  /** 模型获取函数名称（可选） */
  fetchModels?: FetchModelsFunction;
  /** 余额检查函数名称（可选） */
  balanceCheck?: BalanceCheckFunction;
}

/**
 * 所有提供商的配置对象
 */
export type ProvidersConfig = Record<string, ProviderMetadata>;

/**
 * 用户配置的提供商设置
 */
export interface ProviderConfig {
  /** 提供商 key */
  provider: string;
  /** API 基础 URL */
  baseUrl: string;
  /** 测试模型 */
  model: string;
  /** 是否启用流式响应 */
  enableStream: boolean;
  /** 区域代码（可选） */
  region?: string;
  /** 验证提示词（可选） */
  validationPrompt?: string;
  /** 最大 tokens 数（可选） */
  validationMaxTokens?: number;
  /** 最大输出 tokens 数（可选） */
  validationMaxOutputTokens?: number;
}
