/**
 * @description 将用户输入的文本解析为 Key 数组。
 * 支持逗号、分号、换行符作为分隔符。
 * @param {string} input - 原始输入文本。
 * @returns {string[]} - 去重前的 Key 数组。
 */
export function parseKeys(input) {
    return input.trim().split(/[,;\n\r]+/).map(t => t.trim()).filter(Boolean);
}
