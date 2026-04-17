import { secureProxiedFetch } from './utils/fetcher.js';
import { normalizeBaseUrl } from './utils/url.js';

/**
 * @description 余额获取失败时的默认返回值。
 */
const BALANCE_UNAVAILABLE = { balance: -1, message: "有效但无法获取余额" };

/**
 * @description 包含所有特定于提供商的余额检查逻辑。
 * 每个函数接收 token, baseUrl, region, 和 env，并返回一个包含余额信息的对象。
 */
const balanceCheckers = {
    async checkOpenRouterBalance(token, baseUrl, region, env) {
        const creditsUrl = normalizeBaseUrl(baseUrl).replace("/v1", "") + "/v1/credits";
        const creditsResponse = await secureProxiedFetch(creditsUrl, { method: "GET", headers: { Authorization: "Bearer " + token } }, region, env, 10000);
        if (creditsResponse.ok) {
            const d = await creditsResponse.json();
            const total = d.data?.total_credits || 0;
            const usage = d.data?.total_usage || 0;
            return {
                balance: parseFloat((total - usage).toFixed(4)),
                totalBalance: total,
                usedBalance: usage,
                rawBalanceResponse: d,
            };
        }
        return BALANCE_UNAVAILABLE;
    },
    async checkSiliconFlowBalance(token, baseUrl, region, env) {
        const resp = await secureProxiedFetch(normalizeBaseUrl(baseUrl).replace("/v1", "") + "/v1/user/info", { method: "GET", headers: { Authorization: "Bearer " + token } }, region, env, 10000);
        if (resp.ok) {
            const d = await resp.json();
            const bal = parseFloat(d.data?.balance);
            return {
                balance: isNaN(bal) ? -1 : parseFloat(bal.toFixed(4)),
                rawBalanceResponse: d,
            };
        }
        return BALANCE_UNAVAILABLE;
    },
    async checkDeepSeekBalance(token, baseUrl, region, env) {
        const resp = await secureProxiedFetch(
            normalizeBaseUrl(baseUrl).replace("/v1", "") + "/user/balance",
            { method: "GET", headers: { Authorization: "Bearer " + token, Accept: "application/json" } },
            region, env, 10000
        );
        if (resp.ok) {
            const d = await resp.json();
            const info = d.balance_infos?.find((b) => b.currency === "USD") || d.balance_infos?.find((b) => b.currency === "CNY") || d.balance_infos?.[0];
            if (info) {
                return {
                    balance: parseFloat(info.total_balance),
                    currency: info.currency,
                    grantedBalance: parseFloat(info.granted_balance || 0),
                    toppedUpBalance: parseFloat(info.topped_up_balance || 0),
                    rawBalanceResponse: d,
                };
            }
        }
        return BALANCE_UNAVAILABLE;
    },
    async checkMoonshotBalance(token, baseUrl, region, env) {
        const balanceResponse = await secureProxiedFetch(normalizeBaseUrl(baseUrl) + "/users/me/balance", { method: "GET", headers: { Authorization: "Bearer " + token } }, region, env, 10000);
        if (balanceResponse.ok) {
            const data = await balanceResponse.json();
            return {
                balance: parseFloat(data.data?.available_balance) || -1,
                rawBalanceResponse: data,
            };
        }
        return BALANCE_UNAVAILABLE;
    },
    async checkNewAPIBalance(token, baseUrl, region, env) {
        const creditsUrl = normalizeBaseUrl(baseUrl).replace("/v1", "") + "/api/usage/token";
        const response = await secureProxiedFetch(
            creditsUrl,
            { method: "GET", headers: { Authorization: "Bearer " + token } },
            region, env, 10000
        );
        if (response.ok) {
            const d = await response.json();
            if (d.code === true && d.data) {
                const tokenToUsdRate = 500000;
                const availableUsd = parseFloat((d.data.total_available / tokenToUsdRate).toFixed(2));
                const grantedUsd = parseFloat((d.data.total_granted / tokenToUsdRate).toFixed(2));
                return {
                    balance: availableUsd,
                    totalGranted: grantedUsd,
                    expiresAt: d.data.expires_at,
                    currency: 'USD',
                    rawBalanceResponse: d,
                };
            }
        }
        return BALANCE_UNAVAILABLE;
    },
};

/**
 * @description 统一处理上游 API 的错误响应，提取关键错误信息。
 * @param {Response} response - fetch API 返回的 Response 对象。
 * @returns {Promise<{message: string, rawError: object, errorCategory: string}>} - 包含格式化消息、原始错误和错误分类的对象。
 */
async function handleApiError(response) {
    const rawText = await response.text();
    let rawErrorContent;
    try {
        rawErrorContent = JSON.parse(rawText);
    } catch (e) {
        rawErrorContent = rawText;
    }
    let message;
    let errorCategory = 'unknown';
    const reason = rawErrorContent?.error?.details?.[0]?.reason;
    const code = rawErrorContent?.error?.code;
    const errorType = rawErrorContent?.error?.type;
    const errorMessage = rawErrorContent?.error?.message;
    const topLevelMessage = rawErrorContent?.message;
    const detail = rawErrorContent?.detail;
    const lowerCaseContent = JSON.stringify(rawErrorContent).toLowerCase();

    // 优先级从高到低进行错误分类
    if (response.status === 401 || code === 'invalid_api_key' || errorType === 'invalid_api_key') {
        message = "API Key 无效或格式错误";
        errorCategory = 'invalid_key';
    } else if (errorType === 'access_terminated' || lowerCaseContent.includes('terminated') || lowerCaseContent.includes('banned')) {
        message = "账户已被封禁或停用";
        errorCategory = 'account_banned';
    } else if (response.status === 402 || code === 'insufficient_quota' || errorType === 'insufficient_quota') {
        message = "额度不足";
        errorCategory = 'no_quota';
    } else if (response.status === 429) {
        message = "请求频繁 (Rate Limit)";
        errorCategory = 'rate_limit';
    } else if (response.status === 403 || lowerCaseContent.includes('permission') || lowerCaseContent.includes('forbidden')) {
        message = "访问被拒绝 (权限不足)";
        errorCategory = 'permission_denied';
    } else if (lowerCaseContent.includes('location') || lowerCaseContent.includes('region') || lowerCaseContent.includes('country')) {
        message = "区域限制";
        errorCategory = 'region_blocked';
    } else if (code === 'model_not_found' || lowerCaseContent.includes('model') && lowerCaseContent.includes('not found')) {
        message = "模型不存在或不可用";
        errorCategory = 'model_not_found';
    } else if (reason) {
        message = String(reason);
    } else if (code && isNaN(code)) {
        message = String(code);
    } else if (errorMessage) {
        message = String(errorMessage);
    } else if (topLevelMessage) {
        message = String(topLevelMessage);
    } else if (rawErrorContent?.errors?.message) {
        message = String(rawErrorContent.errors.message);
    } else if (detail) {
        message = typeof detail === 'object' ? JSON.stringify(detail) : String(detail);
    } else {
        message = `HTTP ${response.status}`;
    }

    return {
        message,
        errorCategory,
        rawError: {
            status: response.status,
            content: rawErrorContent,
        },
    };
}

/**
 * @description 通用的 API Key 检测模板函数，封装了请求、响应、错误处理和重试的通用逻辑。
 * @param {string} token - 要检测的 API Key。
 * @param {object} providerMeta - 提供商的元数据，来自 providers.json。
 * @param {object} providerConfig - 用户配置的提供商信息。
 * @param {object} env - Cloudflare Worker 的环境变量。
 * @param {object} strategy - 定义了如何构建请求和处理失败的策略对象。
 * @returns {Promise<object>} - 检测结果对象。
 */
async function _checkTokenTemplate(token, providerMeta, providerConfig, env, strategy) {
    const { region, enableStream } = providerConfig;
    try {
        const { url, options } = strategy.buildRequest(token, providerConfig);
        const response = await secureProxiedFetch(url, options, region, env);

        if (response.ok) {
            let result = { token, isValid: true };
            if (enableStream) {
                const reader = response.body.getReader();
                try {
                    const { done } = await reader.read();
                    if (done) return { token, isValid: false, message: "验证失败 (流提前结束)", error: true };
                    result.rawResponse = { note: "Validation successful via streaming." };
                } finally {
                    try {
                        await reader.cancel();
                    } catch (_) {
                        // cancel 失败时忽略，releaseLock 会确保资源释放
                    }
                    try {
                        reader.releaseLock();
                    } catch (_) {
                        // 极端情况下 releaseLock 也可能失败，确保不影响主流程
                    }
                }
            } else {
                result.rawResponse = await response.json().catch(() => ({ note: "Failed to parse JSON response." }));
            }

            if (providerMeta.balanceCheck && balanceCheckers[providerMeta.balanceCheck]) {
                const balanceResult = await balanceCheckers[providerMeta.balanceCheck](token, providerConfig.baseUrl, region, env);
                Object.assign(result, balanceResult);
            }
            return result;
        }

        const error = await handleApiError(response);

        if (strategy.onFail) {
            const retryResult = await strategy.onFail(error, token, providerConfig, env);
            if (retryResult) {
                return retryResult;
            }
        }

        return { token, isValid: false, message: error.message, rawError: error.rawError, error: true };

    } catch (error) {
        return { token, isValid: false, message: "网络错误或未知异常", rawError: { content: error.message }, error: true };
    }
}

/**
 * @description 定义了不同 API 风格的请求构建和失败处理策略。
 */
const apiStrategies = {
    openai: {
        buildRequest: (token, providerConfig) => {
            const { baseUrl, model, enableStream, validationPrompt, validationMaxTokens } = providerConfig;
            const apiUrl = normalizeBaseUrl(baseUrl) + "/chat/completions";
            const headers = { "Content-Type": "application/json", Authorization: "Bearer " + token };
            const body = {
                model,
                messages: [{ role: "user", content: validationPrompt || "Hi" }],
                max_completion_tokens: validationMaxTokens || 16,
                stream: enableStream || false
            };
            return { url: apiUrl, options: { method: "POST", headers, body: JSON.stringify(body) } };
        },
        onFail: async (error, token, providerConfig, env) => {
            // 如果 max_completion_tokens 不支持，回退到 max_tokens（兼容旧模型）
            if (error.rawError?.content?.error?.code === 'unsupported_parameter' && error.rawError?.content?.error?.param === 'max_completion_tokens') {
                const { url, options } = apiStrategies.openai.buildRequest(token, providerConfig);
                const newBody = JSON.parse(options.body);
                delete newBody.max_completion_tokens;
                newBody.max_tokens = providerConfig.validationMaxTokens || 16;
                options.body = JSON.stringify(newBody);
                const retryStrategy = { buildRequest: () => ({ url, options }) };
                return await _checkTokenTemplate(token, {}, providerConfig, env, retryStrategy);
            }
            return null;
        }
    },
    openai_responses: {
        buildRequest: (token, providerConfig) => {
            const { baseUrl, model, enableStream, validationPrompt, validationMaxOutputTokens } = providerConfig;
            const apiUrl = normalizeBaseUrl(baseUrl) + "/responses";
            const headers = { "Content-Type": "application/json", Authorization: "Bearer " + token };
            const body = {
                model,
                input: validationPrompt || "You just need to reply Hi.",
                max_output_tokens: validationMaxOutputTokens || 16,
                stream: enableStream || false
            };
            return { url: apiUrl, options: { method: "POST", headers, body: JSON.stringify(body) } };
        }
    },
    anthropic: {
        buildRequest: (token, providerConfig) => {
            const { baseUrl, model, enableStream, validationPrompt, validationMaxTokens } = providerConfig;
            const apiUrl = normalizeBaseUrl(baseUrl) + "/messages";
            const headers = {
                "x-api-key": token,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
                "anthropic-dangerous-direct-browser-access": "true"
            };
            const body = {
                model,
                max_tokens: validationMaxTokens || 16,
                messages: [{ role: "user", content: validationPrompt || "You just need to reply Hi." }],
                stream: enableStream || false,
            };
            return { url: apiUrl, options: { method: "POST", headers, body: JSON.stringify(body) } };
        }
    },
    gemini: {
        buildRequest: (token, providerConfig) => {
            const { baseUrl, model, enableStream, validationPrompt, validationMaxOutputTokens } = providerConfig;
            const endpoint = enableStream ? 'streamGenerateContent' : 'generateContent';
            const apiUrl = `${normalizeBaseUrl(baseUrl)}/v1beta/models/${model}:${endpoint}`;
            const headers = { "Content-Type": "application/json", "x-goog-api-key": token };
            const body = {
                contents: [{ parts: [{ text: validationPrompt || "You just need to reply Hi." }] }],
                generationConfig: { maxOutputTokens: validationMaxOutputTokens || 16 }
            };
            return { url: apiUrl, options: { method: "POST", headers, body: JSON.stringify(body) } };
        }
    },
    tavily: {
        buildRequest: (token, providerConfig) => {
            const { baseUrl } = providerConfig;
            const apiUrl = normalizeBaseUrl(baseUrl) + "/search";
            const headers = { "Content-Type": "application/json" };
            const body = {
                api_key: token,
                query: "test",
                search_depth: "basic",
                max_results: 1
            };
            return { url: apiUrl, options: { method: "POST", headers, body: JSON.stringify(body) } };
        }
    }
};

async function checkOpenAICompatibleToken(token, providerMeta, providerConfig, env) {
    return await _checkTokenTemplate(token, providerMeta, providerConfig, env, apiStrategies.openai);
}

async function checkOpenAIResponsesToken(token, providerMeta, providerConfig, env) {
    return await _checkTokenTemplate(token, providerMeta, providerConfig, env, apiStrategies.openai_responses);
}

async function checkAnthropicToken(token, providerMeta, providerConfig, env) {
    return await _checkTokenTemplate(token, providerMeta, providerConfig, env, apiStrategies.anthropic);
}

async function checkGeminiToken(token, providerMeta, providerConfig, env) {
    return await _checkTokenTemplate(token, providerMeta, providerConfig, env, apiStrategies.gemini);
}

async function checkTavilyToken(token, providerMeta, providerConfig, env) {
    return await _checkTokenTemplate(token, providerMeta, providerConfig, env, apiStrategies.tavily);
}

/**
 * @description 检测单个 API Key 的有效性、额度等信息。
 * 这是暴露给外部（如 websocket_handler）的主要函数。
 * @param {string} token - 要检测的 API Key。
 * @param {object} providerMeta - 提供商的元数据，来自 providers.json。
 * @param {object} providerConfig - 用户配置的提供商信息。
 * @param {object} env - Cloudflare Worker 的环境变量。
 * @returns {Promise<object>} - 检测结果对象。
 */
export async function checkToken(token, providerMeta, providerConfig, env) {
    let checkerFunction;
    switch (providerMeta.apiStyle) {
        case "openai":
            checkerFunction = checkOpenAICompatibleToken;
            break;
        case "openai_responses":
            checkerFunction = checkOpenAIResponsesToken;
            break;
        case "anthropic":
            checkerFunction = checkAnthropicToken;
            break;
        case "gemini":
            checkerFunction = checkGeminiToken;
            break;
        case "tavily":
            checkerFunction = checkTavilyToken;
            break;
        default:
            return { token, isValid: false, message: "不支持的提供商类型", error: true };
    }
    return await checkerFunction(token, providerMeta, providerConfig, env);
}
