/**
 * dsh-slack —— DeepSeek Harness 的 Slack 渠道插件（入口）。
 * 本体在 lib/plugin.js；此处只做宿主约定的导出（name / inject / apply）。
 * inject 必须与 cordis.patch.yml 补丁行保持一致：loader 认补丁行，直接挂载认这里。
 */
import { createSlackPlugin, INJECT, PLUGIN_NAME } from './lib/plugin.js'

const plugin = createSlackPlugin()

export const name = PLUGIN_NAME
export const inject = INJECT
export const apply = plugin.apply
export default plugin
