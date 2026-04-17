import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useConfigStore } from './config';
import { useResultsStore } from './results';
import { categorizeTokenError } from '@/api';
import {
    MAX_KEYS_LIMIT,
    BATCH_SIZE,
    MAX_RECONNECT_ATTEMPTS,
    BUFFER_FLUSH_INTERVAL,
    BUFFER_MAX_SIZE,
    RESULT_CATEGORIES
} from '@/constants';
import { parseKeys } from '@/utils/keyParser';

/**
 * @description checker Store 用于管理 API Key 检测的核心逻辑和状态。
 * 采用内存优先的存储策略，避免 localStorage 配额超限问题。
 */
export const useCheckerStore = defineStore('checker', () => {
    const configStore = useConfigStore();
    const resultsStore = useResultsStore();

    // --- 会话管理 (Session Management) ---
    /** @type {Ref<string|null>} 当前浏览器标签页的唯一会话 ID。*/
    const sessionId = ref(null);

    // --- 状态 (State) ---
    /** @type {Ref<boolean>} 检测任务是否正在进行中。*/
    const isChecking = ref(false);
    /** @type {Ref<boolean>} 检测任务是否处于暂停状态。*/
    const isPaused = ref(false);
    /** @type {Ref<number>} 已完成检测的 Key 数量。*/
    const completedCount = ref(0);
    /** @type {Ref<number>} 待检测 Key 的总数。*/
    const totalTasks = ref(0);
    /** @type {Ref<WebSocket|null>} 当前会话的 WebSocket 连接实例（跨批次复用）。*/
    const socket = ref(null);
    /** @type {Ref<object|null>} 用于向 UI 层传递状态消息的对象。*/
    const lastStatusMessage = ref(null);
    /** @type {number} WebSocket 重连尝试次数。*/
    let reconnectAttempts = 0;
    /** @type {Array<object>|null} 当前正在处理的批次，用于重连时恢复。*/
    let currentBatch = null;
    /** @type {Function|null} 当前批次完成时的 resolve 回调。*/
    let batchDoneResolve = null;
    /** @type {Set<number>} 已完成的 order 集合，用于断线恢复时去重。*/
    let completedOrders = new Set();

    // --- 内存任务队列 (Memory-based Job Queue) ---
    /**
     * @description 任务队列存储在内存中，避免 localStorage 配额限制。
     * @type {object|null}
     */
    let jobQueue = null;

    // --- 结果缓冲区 (Result Buffer) ---
    /** @type {Array<{res: object, order: number}>} 结果缓冲区，用于批量添加结果。*/
    let resultBuffer = [];
    /** @type {number|null} 缓冲区刷新定时器 ID。*/
    let flushTimerId = null;

    // --- 计算属性 (Getters) ---
    /** @type {ComputedRef<number>} 检测进度百分比。*/
    const progress = computed(() => {
        if (totalTasks.value === 0) return 0;
        return Math.round((completedCount.value / totalTasks.value) * 100);
    });

    // --- 私有方法 (Private Methods) ---
    /**
     * @description 向 UI 层发布状态消息。
     * @param {string} text - 消息文本。
     * @param {string} [type='info'] - 消息类型（如 'info', 'warning', 'error', 'success'）。
     * @param {number} [duration=3000] - 消息显示时长（毫秒）。
     */
    function _postStatus(text, type = 'info', duration = 3000) {
        lastStatusMessage.value = { text, type, duration, id: Date.now() };
    }

    /**
     * @description 主调度函数，从内存队列读取任务状态，处理下一个批次或完成任务。
     */
    async function processNextBatch() {
        if (isPaused.value) return;

        reconnectAttempts = 0;

        if (!jobQueue || jobQueue.remainingKeys.length === 0) {
            // 所有批次处理完毕，通知后端关闭连接
            _closeSocket('done');
            finishCheck();
            return;
        }

        const batch = jobQueue.remainingKeys.slice(0, BATCH_SIZE);
        const remaining = jobQueue.remainingKeys.slice(BATCH_SIZE);

        currentBatch = { batch, providerConfig: jobQueue.providerConfig, concurrency: jobQueue.concurrency };
        jobQueue.remainingKeys = remaining;

        _postStatus(`正在处理 ${totalTasks.value - remaining.length} / ${totalTasks.value} 个 Key...`, "info");

        try {
            // 确保 WebSocket 连接可用
            await _ensureConnection();
            // 发送批次并等待完成
            await _sendBatchAndWait(jobQueue.providerConfig, batch, jobQueue.concurrency);
            currentBatch = null;
            // 处理下一个批次
            processNextBatch();
        } catch (err) {
            // 连接失败，尝试重连
            if (isChecking.value && !isPaused.value) {
                _handleConnectionFailure();
            }
        }
    }

    /**
     * @description 确保 WebSocket 连接已建立且处于 OPEN 状态。
     * @returns {Promise<void>}
     */
    function _ensureConnection() {
        return new Promise((resolve, reject) => {
            if (socket.value && socket.value.readyState === WebSocket.OPEN) {
                resolve();
                return;
            }

            // 关闭旧连接（如果有）
            _cleanupSocket();

            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = window.location.host;
            const ws = new WebSocket(`${protocol}//${host}/check`);

            ws.onopen = () => {
                socket.value = ws;
                _setupMessageHandler(ws);
                resolve();
            };

            ws.onerror = () => {
                reject(new Error('WebSocket connection failed'));
            };

            // 如果在连接过程中关闭
            ws.onclose = (event) => {
                if (event.code !== 1000 && socket.value === ws) {
                    reject(new Error('WebSocket closed during connection'));
                }
            };
        });
    }

    /**
     * @description 为 WebSocket 设置消息处理器。
     * @param {WebSocket} ws - WebSocket 实例。
     */
    function _setupMessageHandler(ws) {
        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            if (message.type === 'result') {
                processResult(message.data);
                if (currentBatch) {
                    currentBatch.batch = currentBatch.batch.filter(k => k.order !== message.data.order);
                }
            } else if (message.type === 'batch_done') {
                // 批次完成，触发 resolve 让 processNextBatch 继续
                if (batchDoneResolve) {
                    batchDoneResolve();
                    batchDoneResolve = null;
                }
            } else if (message.type === 'error') {
                _postStatus(`后端错误: ${message.message}`, "error");
                stopCheck();
            }
        };

        ws.onclose = (event) => {
            if (event.code !== 1000 && isChecking.value && !isPaused.value) {
                _handleConnectionFailure();
            }
        };

        ws.onerror = () => {
            // onerror 后通常会触发 onclose，实际重连逻辑在 onclose 中处理
        };
    }

    /**
     * @description 发送一个批次到后端并等待 batch_done 消息。
     * @param {object} providerConfig - 提供商配置。
     * @param {Array<object>} batch - 当前批次的 Key 列表。
     * @param {number} concurrency - 并发数。
     * @returns {Promise<void>}
     */
    function _sendBatchAndWait(providerConfig, batch, concurrency) {
        return new Promise((resolve, reject) => {
            batchDoneResolve = resolve;

            if (!socket.value || socket.value.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket not connected'));
                return;
            }

            socket.value.send(JSON.stringify({
                command: 'start',
                data: { tokens: batch, providerConfig, concurrency }
            }));
        });
    }

    /**
     * @description 处理连接失败，尝试重连。
     */
    function _handleConnectionFailure() {
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS && currentBatch && currentBatch.batch.length > 0) {
            reconnectAttempts++;
            _postStatus(`连接断开，正在重试 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`, "warning");
            _cleanupSocket();

            // 过滤掉已完成的 Key，避免重复检测
            const unfinishedBatch = currentBatch.batch.filter(k => !completedOrders.has(k.order));

            // 将未完成的批次放回队列
            if (jobQueue && unfinishedBatch.length > 0) {
                jobQueue.remainingKeys = [...unfinishedBatch, ...jobQueue.remainingKeys];
            }
            currentBatch = null;

            setTimeout(() => {
                if (isChecking.value && !isPaused.value) {
                    processNextBatch();
                }
            }, 1000 * reconnectAttempts);
        } else {
            _postStatus("检测连接意外关闭，重连失败，任务已停止。", "error");
            stopCheck();
        }
    }

    /**
     * @description 清理 WebSocket 连接，移除事件监听器。
     */
    function _cleanupSocket() {
        if (socket.value) {
            socket.value.onopen = null;
            socket.value.onmessage = null;
            socket.value.onclose = null;
            socket.value.onerror = null;
            socket.value = null;
        }
        batchDoneResolve = null;
    }

    /**
     * @description 关闭 WebSocket 连接。
     * @param {string} [command] - 关闭前发送的命令（如 'done' 或 'stop'）。
     */
    function _closeSocket(command) {
        if (socket.value && socket.value.readyState === WebSocket.OPEN) {
            if (command) {
                try { socket.value.send(JSON.stringify({ command })); } catch (_) {}
            }
            socket.value.onclose = null;
            socket.value.close(1000, command === 'done' ? 'All batches complete' : 'Client closed');
        }
        _cleanupSocket();
    }

    /**
     * @description 刷新结果缓冲区，批量添加结果到 store。
     */
    function flushResultBuffer() {
        if (resultBuffer.length === 0) return;

        // 复制缓冲区并清空
        const itemsToAdd = resultBuffer;
        resultBuffer = [];

        // 清除定时器
        if (flushTimerId !== null) {
            clearTimeout(flushTimerId);
            flushTimerId = null;
        }

        // 批量添加到 store
        resultsStore.addResults(itemsToAdd);
    }

    /**
     * @description 将结果添加到缓冲区，并在适当时机刷新。
     * @param {object} res - 处理后的结果对象。
     * @param {number} order - 结果顺序。
     */
    function bufferResult(res, order) {
        resultBuffer.push({ res, order });

        // 如果缓冲区达到最大容量，立即刷新
        if (resultBuffer.length >= BUFFER_MAX_SIZE) {
            flushResultBuffer();
            return;
        }

        // 否则，设置延迟刷新（如果尚未设置）
        if (flushTimerId === null) {
            flushTimerId = setTimeout(flushResultBuffer, BUFFER_FLUSH_INTERVAL);
        }
    }

    /**
     * @description 处理单个 Key 的检测结果，更新进度并缓冲结果。
     * @param {object} res - 单个 Key 的检测结果数据。
     */
    function processResult(res) {
        if (!res) return;

        // 记录已完成的 order，用于断线恢复去重
        completedOrders.add(res.order);

        completedCount.value++;
        const { category } = categorizeTokenError(res);
        res.finalCategory = category;

        if (res.isValid && configStore.providers[configStore.currentProvider].hasBalance) {
            if (res.balance === 0) res.finalCategory = 'zeroBalance';
            else if (res.balance < configStore.threshold) res.finalCategory = 'lowBalance';
            else res.finalCategory = 'valid';
        }

        // 使用缓冲区而非直接添加
        bufferResult(res, res.order);
    }

    /**
     * @description 完成所有检测任务后的收尾工作。
     */
    function finishCheck() {
        // 刷新缓冲区中剩余的结果
        flushResultBuffer();

        isChecking.value = false;
        // 清理内存队列和去重集合
        jobQueue = null;
        currentBatch = null;
        completedOrders.clear();

        // 定义分类 ID 到中文名称的映射
        const categoryMap = {
            valid: '有效',
            lowBalance: '低额',
            zeroBalance: '零额',
            noQuota: '无额',
            rateLimit: '限流',
            invalid: '无效',
            duplicate: '重复'
        };

        const summaryParts = [];
        // 遍历映射，按顺序生成摘要部分
        for (const category in categoryMap) {
            const count = resultsStore.results[category].length;
            if (count > 0) {
                summaryParts.push(`${categoryMap[category]} ${count}`);
            }
        }

        const summaryString = summaryParts.join('，');
        const finalMessage = summaryString ? `检测完成！${summaryString}` : '检测完成！没有有效结果。';

        _postStatus(finalMessage, "success", 8000); // 延长显示时间以便用户阅读
    }

    // --- 公开动作 (Public Actions) ---
    /**
     * @description 初始化会话，在应用根组件加载时调用。
     * 为当前浏览器标签页分配一个唯一的 ID，存储在 sessionStorage 中。
     */
    function initSession() {
        let existingSessionId = sessionStorage.getItem('llm_checker_session_id');
        if (!existingSessionId) {
            existingSessionId = crypto.randomUUID();
            sessionStorage.setItem('llm_checker_session_id', existingSessionId);
        }
        sessionId.value = existingSessionId;
    }

    /**
     * @description 开始一个全新的检测任务。
     */
    function startCheck() {
        if (configStore.tokensInput.trim() === '') {
            _postStatus("请输入至少一个 API KEY", "warning");
            return;
        }

        // 清理旧任务和去重集合
        jobQueue = null;
        completedOrders.clear();
        resultsStore.clearResults();
        completedCount.value = 0;

        const tokensRaw = parseKeys(configStore.tokensInput);

        // 检查 Key 数量限制
        if (tokensRaw.length > MAX_KEYS_LIMIT) {
            _postStatus(`Key 数量超过限制（最多 ${MAX_KEYS_LIMIT.toLocaleString()} 个），请分批检测`, "error", 5000);
            return;
        }

        const uniqueTokens = new Set();
        const allKeys = tokensRaw.map((token, index) => ({ token, order: index }));

        const keysToProcess = [];
        const duplicateResults = [];

        allKeys.forEach(keyObj => {
            if (uniqueTokens.has(keyObj.token)) {
                duplicateResults.push({ res: { token: keyObj.token, finalCategory: 'duplicate' }, order: keyObj.order });
            } else {
                uniqueTokens.add(keyObj.token);
                keysToProcess.push(keyObj);
            }
        });

        // 批量添加重复 Key 到结果
        if (duplicateResults.length > 0) {
            resultsStore.addResults(duplicateResults);
            _postStatus(`已过滤 ${duplicateResults.length} 个重复 Key`, "info", 2000);
        }

        if (keysToProcess.length === 0) {
            _postStatus("没有需要检测的 KEY（已去除重复项）", "info");
            return;
        }

        isChecking.value = true;
        isPaused.value = false;
        totalTasks.value = keysToProcess.length;

        const currentProviderKey = configStore.currentProvider;
        const providerSettings = configStore.getCurrentProviderConfig();
        const providerConfig = {
            provider: currentProviderKey,
            baseUrl: providerSettings.baseUrl,
            model: providerSettings.model,
            enableStream: providerSettings.enableStream,
            region: configStore.currentRegion,
            validationPrompt: configStore.validationPrompt,
            validationMaxTokens: configStore.validationMaxTokens,
            validationMaxOutputTokens: configStore.validationMaxOutputTokens,
        };

        // 存储到内存队列
        jobQueue = {
            remainingKeys: keysToProcess,
            providerConfig,
            concurrency: configStore.concurrency,
        };

        _postStatus(`开始检测 ${keysToProcess.length} 个 Key...`, "info");
        processNextBatch();
    }

    /**
     * @description 停止当前检测任务，清理会话状态。
     */
    function stopCheck() {
        flushResultBuffer();

        isChecking.value = false;
        isPaused.value = false;
        jobQueue = null;
        currentBatch = null;
        completedOrders.clear();
        _closeSocket('stop');
        _postStatus("检测已手动停止", "info");
    }

    /**
     * @description 暂停当前检测任务。
     * 保持 WebSocket 连接，但停止发送新批次。
     */
    function pauseCheck() {
        if (!isChecking.value || isPaused.value) return;

        flushResultBuffer();
        isPaused.value = true;

        // 将当前未完成的批次放回队列头部
        if (currentBatch && currentBatch.batch.length > 0 && jobQueue) {
            jobQueue.remainingKeys = [...currentBatch.batch, ...jobQueue.remainingKeys];
        }

        _postStatus("检测已暂停", "info");
        currentBatch = null;
    }

    /**
     * @description 恢复暂停的检测任务。
     */
    function resumeCheck() {
        if (!isChecking.value || !isPaused.value) return;

        isPaused.value = false;
        _postStatus("检测已恢复", "info");

        processNextBatch();
    }

    return {
        initSession,
        isChecking,
        isPaused,
        completedCount,
        totalTasks,
        progress,
        lastStatusMessage,
        startCheck,
        pauseCheck,
        resumeCheck,
        stopCheck,
    };
});
