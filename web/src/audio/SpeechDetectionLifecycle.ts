import type { SpeechDetectionEngine } from './SpeechDetectionEngine.ts'

export interface SpeechDetectionLifecycleOptions {
  engine: SpeechDetectionEngine
  // 生命周期存活：登录且浏览器已授予麦克风权限。
  isActive: () => boolean
  // 首选输入设备（空串表示浏览器默认设备）。
  preferredInputDeviceId: () => string
  // 订阅环境事件（标签页可见、设备变化），返回退订函数。
  subscribeRetryEvents: (listener: () => void) => () => void
}

// SpeechDetectionLifecycle 是常开说话检测引擎（ADR-0024）的应用级生命周期：
// 登录且麦克风授权时启动、退出登录或权限丢失时停止、首选输入设备变化时重启
// 采集；消费方不参与启停，只订阅说话事件流。引擎失败后保持停摆，仅在环境
// 事件（标签页恢复可见、设备变化、权限重新授予）时重试，不引入定时重试。
export class SpeechDetectionLifecycle {
  private engine: SpeechDetectionEngine
  private options: SpeechDetectionLifecycleOptions
  private failed = false
  private unsubscribeRetryEvents: () => void

  constructor(options: SpeechDetectionLifecycleOptions) {
    this.engine = options.engine
    this.options = options
    this.engine.onFailure(() => {
      this.failed = true
    })
    this.unsubscribeRetryEvents = options.subscribeRetryEvents(() => this.onRetryEvent())
  }

  // state 供装配方 watch：返回当前活跃性与首选设备快照，任一依赖变化即触发。
  state() {
    return {
      active: this.options.isActive(),
      deviceId: this.options.preferredInputDeviceId(),
    }
  }

  // sync 由装配方在登录、权限与设备偏好变化时调用：按当前状态启停或重启采集。
  sync() {
    if (!this.options.isActive()) {
      this.engine.stop()
      return
    }
    if (this.failed) {
      this.retry()
      return
    }
    void this.engine.start(this.options.preferredInputDeviceId())
  }

  private onRetryEvent() {
    if (!this.options.isActive()) return
    if (!this.failed) return
    this.retry()
  }

  private retry() {
    this.engine.resetFailure()
    void this.engine.start(this.options.preferredInputDeviceId())
  }
}
