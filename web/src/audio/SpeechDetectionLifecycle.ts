import type { SpeechDetectionEngine } from './SpeechDetectionEngine.ts'

export interface SpeechDetectionLifecycleOptions {
  engine: SpeechDetectionEngine
  // 生命周期存活：登录且浏览器已授予麦克风权限。
  isActive: () => boolean
  // 当前应跟随的输入设备（空串表示浏览器默认设备）。
  inputDeviceId: () => string
  // 输入路由世代：真正重绑（含系统默认强制重建）时递增；名单刷新不递增。
  inputRoutingGeneration?: () => number
  // 订阅环境事件（标签页可见、设备变化），返回退订函数。
  subscribeRetryEvents: (listener: () => void) => () => void
}

// SpeechDetectionLifecycle 是常开说话检测引擎（ADR-0024）的应用级生命周期：
// 登录且麦克风授权时启动、退出登录或权限丢失时停止；跟随目标或路由世代变化
// 时重启采集。消费方不参与启停，只订阅说话事件流。引擎失败后保持停摆，仅在
// 环境事件（标签页恢复可见、设备变化、权限重新授予）时重试，不引入定时重试。
export class SpeechDetectionLifecycle {
  private engine: SpeechDetectionEngine
  private options: SpeechDetectionLifecycleOptions
  private failed = false
  private lastSyncedGeneration: number | null = null
  private unsubscribeRetryEvents: () => void

  constructor(options: SpeechDetectionLifecycleOptions) {
    this.engine = options.engine
    this.options = options
    this.engine.onFailure(() => {
      this.failed = true
    })
    this.unsubscribeRetryEvents = options.subscribeRetryEvents(() => this.onRetryEvent())
  }

  // state 供装配方 watch：活跃性、跟随设备与路由世代任一变化即触发。
  state() {
    return {
      active: this.options.isActive(),
      deviceId: this.options.inputDeviceId(),
      routingGeneration: this.options.inputRoutingGeneration?.() ?? 0,
    }
  }

  // sync 由装配方在登录、权限与设备跟随变化时调用：按当前状态启停或强制重建。
  sync() {
    if (!this.options.isActive()) {
      this.engine.stop()
      this.lastSyncedGeneration = null
      return
    }
    if (this.failed) {
      this.retry()
      return
    }
    const deviceId = this.options.inputDeviceId()
    const generation = this.options.inputRoutingGeneration?.() ?? 0
    if (this.lastSyncedGeneration !== null && generation !== this.lastSyncedGeneration) {
      this.lastSyncedGeneration = generation
      void this.engine.restart(deviceId)
      return
    }
    this.lastSyncedGeneration = generation
    void this.engine.start(deviceId)
  }

  private onRetryEvent() {
    if (!this.options.isActive()) return
    if (!this.failed) return
    this.retry()
  }

  private retry() {
    this.engine.resetFailure()
    void this.engine.start(this.options.inputDeviceId())
  }
}
