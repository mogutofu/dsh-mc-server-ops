/**
 * 写操作适配器：把 start / stop / restart / sendCommand / getStatus
 * 从「写死调 PowerShell」里抽出来，换成可替换的实现。
 *
 *   local —— 本机直接跑 ops/mcadmin.ps1（Windows）或 ops/rcon.mjs（其它平台），行为不变
 *   panel —— Pterodactyl 面板 HTTP API，适合把服务器托管在别人机器上的情况
 *
 * 只读路径（status / players / logs / crashinfo）不经过这里，仍然走原来的逻辑。
 */

import { LocalShellAdapter } from './local.mjs'
import { PterodactylAdapter } from './pterodactyl.mjs'

export { LocalShellAdapter } from './local.mjs'
export { PterodactylAdapter } from './pterodactyl.mjs'

/** 配置文件里 adapter 字段的合法取值。 */
export const ADAPTER_KINDS = ['local', 'panel']

/**
 * @param {string} kind 'local' | 'panel'
 * @param {object} options 适配器需要的依赖（本地：runMcAdmin/runNodeOps；面板：url/serverId/clientApiKey）
 * @returns {{kind: string, start: Function, stop: Function, restart: Function, sendCommand: Function, getStatus: Function}}
 */
export function createAdapter(kind, options = {}) {
  const which = String(kind || 'local').toLowerCase()
  if (which === 'panel') {
    const panel = options.panel || {}
    return new PterodactylAdapter({
      url: panel.url,
      serverId: panel.serverId,
      clientApiKey: panel.clientApiKey,
      fetchImpl: options.fetchImpl,
    })
  }
  return new LocalShellAdapter(options)
}
