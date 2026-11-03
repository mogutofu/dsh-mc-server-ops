/**
 * 本机适配器：行为和改造前一模一样，只是收进了统一接口。
 *
 * Windows 上走 powershell + ops/mcadmin.ps1（信息最全、能改文件、能看进程）；
 * 其它平台上 open/close 类动作走 ops/rcon.mjs（纯 Node，无 PowerShell 依赖）。
 */

const DEFAULT_TIMEOUT = 170000

export class LocalShellAdapter {
  /**
   * @param {object} deps
   * @param {(argv: string[], timeoutMs: number) => Promise<{ok:boolean,text:string}>} deps.runMcAdmin
   * @param {(action: string, arg: string, timeoutMs: number, owner: boolean) => Promise<{ok:boolean,text:string}>} deps.runNodeOps
   * @param {boolean} deps.isWindows
   * @param {Set<string>} deps.nodeActions 非 Windows 上可以走 Node 的动作
   */
  constructor(deps = {}) {
    this.kind = 'local'
    this.runMcAdmin = deps.runMcAdmin
    this.runNodeOps = deps.runNodeOps
    this.isWindows = deps.isWindows !== false
    this.nodeActions = deps.nodeActions || new Set()
  }

  async start(opts) { return this._act('start', '', opts) }
  async stop(opts) { return this._act('stop', '', opts) }
  async restart(opts) { return this._act('restart', '', opts) }
  async sendCommand(cmd, opts) { return this._act('cmd', String(cmd || ''), opts) }
  async getStatus(opts) { return this._act('status', '', opts) }

  async _act(action, arg, opts = {}) {
    if (!this.isWindows && this.nodeActions.has(action) && typeof this.runNodeOps === 'function') {
      return this.runNodeOps(action, arg, 60000, !!opts.owner)
    }
    if (typeof this.runMcAdmin !== 'function') {
      return { ok: false, text: '本机适配器没有拿到 mcadmin 的执行入口。' }
    }
    const cli = ['-Action', action, '-Actor', String(opts.actor || ''), '-Channel', String(opts.channel || 'console')]
    if (arg !== '') cli.push('-Arg', arg)
    return this.runMcAdmin(cli, opts.timeoutMs || DEFAULT_TIMEOUT)
  }
}

export default LocalShellAdapter
