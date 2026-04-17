<template>
    <div class="provider-config-area" v-if="currentConfig">
        <div class="config-grid">
            <div class="config-item">
                <label :for="configStore.currentProvider + '__base'">Base URL</label>
                <input type="text" :id="configStore.currentProvider + '__base'" v-model="currentConfig.baseUrl"
                    placeholder="API Base URL" :disabled="checkerStore.isChecking">
            </div>
            <div class="config-item">
                <label :for="configStore.currentProvider + '__model'">测试模型</label>
                <div class="input-with-button">
                    <input type="text" :id="configStore.currentProvider + '__model'" v-model="currentConfig.model"
                        placeholder="测试用的模型名称" :disabled="checkerStore.isChecking">
                    <button type="button" class="fetch-models-btn" @click="handleFetchModels"
                        :disabled="uiStore.isFetchingModels || checkerStore.isChecking">
                        <span v-if="!uiStore.isFetchingModels">获取</span>
                        <span v-else class="loader"></span>
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup>
import { computed } from 'vue';
import { useConfigStore } from '@/stores/config';
import { useUiStore } from '@/stores/ui';
import { useCheckerStore } from '@/stores/checker';
import { fetchModels } from '@/api';
import { parseKeys } from '@/utils/keyParser';

const configStore = useConfigStore();
const uiStore = useUiStore();
const checkerStore = useCheckerStore();

/**
 * @description 计算属性，获取当前选中提供商的配置。
 */
const currentConfig = computed(() => {
    return configStore.getCurrentProviderConfig();
});

/**
 * @description 处理获取模型列表的逻辑。
 * 根据输入 Key 的数量，决定是直接显示错误还是遍历尝试。
 * 最多尝试 5 个 Key，避免等待时间过长。
 */
const handleFetchModels = async () => {
    uiStore.isFetchingModels = true; // 设置加载状态
    try {
        // 解析所有输入的 Key
        const keys = parseKeys(configStore.tokensInput);
        if (keys.length === 0) {
            uiStore.showToast("请先输入至少一个有效的KEY", "warning");
            return;
        }

        // 构造提供商配置对象
        const providerConfig = {
            currentProvider: configStore.currentProvider,
            baseUrl: currentConfig.value.baseUrl,
            currentRegion: configStore.currentRegion,
        };

        // 如果只有一个 Key，则保持原有行为：失败直接显示错误
        if (keys.length === 1) {
            try {
                const models = await fetchModels(keys[0], providerConfig);
                if (models && models.length > 0) {
                    models.sort((a, b) => a.localeCompare(b)); // 排序模型列表
                    uiStore.openModal('modelSelector', { models, currentModel: currentConfig.value.model }); // 打开模型选择器
                } else {
                    uiStore.showToast("未能获取到模型列表", "warning");
                }
            } catch (error) {
                uiStore.showToast(`获取模型失败: ${error.message}`, "error");
            }
        } else {
            // 如果有多个 Key，则遍历尝试，最多尝试 5 个
            const maxAttempts = Math.min(keys.length, 5);
            for (let i = 0; i < maxAttempts; i++) {
                const key = keys[i];
                try {
                    const models = await fetchModels(key, providerConfig);
                    if (models && models.length > 0) {
                        models.sort((a, b) => a.localeCompare(b));
                        uiStore.openModal('modelSelector', { models, currentModel: currentConfig.value.model });
                        return; // 成功获取，立即返回，不再尝试其他 Key
                    }
                } catch (error) {
                    // 静默失败，继续尝试下一个 Key，仅在控制台输出日志
                    console.log(`Key ${key.substring(0, 10)}... failed, trying next.`);
                }
            }
            // 如果循环结束都没有成功，则提示失败
            const attemptedMsg = maxAttempts < keys.length ? `前 ${maxAttempts} 个` : '所有';
            uiStore.showToast(`${attemptedMsg} KEY 均无法获取到模型列表`, "error");
        }
    } finally {
        uiStore.isFetchingModels = false; // 无论成功或失败，都关闭加载状态
    }
};
</script>

<style scoped>
    .provider-config-area {
        margin-top: 20px;
        padding-top: 20px;
        border-top: 1px solid var(--border-color-light);
    }

    .config-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
    }

    @media (max-width: 768px) {
        .config-grid {
            grid-template-columns: 1fr;
        }
    }

    .config-item {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .config-item label {
        font-size: 0.9rem;
        margin-bottom: 0;
    }

    .input-with-button {
        display: flex;
        gap: 8px;
    }

    .input-with-button input {
        flex-grow: 1;
    }

    .fetch-models-btn {
        padding: 0 16px;
        color: white;
        border: none;
        border-radius: var(--radius-md);
        font-size: 0.9rem;
        font-weight: 600;
        font-family: var(--font-sans);
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        gap: 6px;
        height: 48px;
        background: var(--accent-dark);
        flex-shrink: 0;
    }

    .fetch-models-btn:hover {
        background: var(--accent-dark-hover);
        transform: translateY(-1px);
    }

    input:disabled {
        background-color: var(--bg-secondary);
        cursor: not-allowed;
    }

    .fetch-models-btn:disabled {
        background: var(--bg-disabled);
        cursor: not-allowed;
        transform: none;
        opacity: 0.7;
    }
</style>