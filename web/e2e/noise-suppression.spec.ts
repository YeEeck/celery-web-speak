// 发送端降噪客观测量与回归门禁。
//
// 思路：Chromium 假麦克风以 --use-file-for-fake-audio-capture 循环播放确定性
// fixture（稳态噪声 + 模拟语音 + 键盘脉冲），账号真实加入语音，在管线 destination
// （发布前最后一环）录制输出；同一会话内依次切三档降噪选项，逐档录制。
// RMS 类指标不依赖采样对齐：录制信号与 fixture 包络归一化互相关定相位，再按
// 已知段窗口取 RMS。参照基准用"关闭"档（同处理链抵消 AGC 等干扰），而非 fixture。
//
// 门禁（防"降噪失效/静音"回归）——全部是会话内相对断言：无头环境的绝对降噪量
// 在会话间不稳定（实测 -25~-45dB 波动，机制未定位，属环境偶发状态），但同一
// 会话内三档共享同一环境状态，相对关系稳定可靠：
//   1. 增强降噪噪声削减（相对关闭档）≥ NOISE_REDUCTION_MIN_DB
//   2. 增强降噪语音衰减 ≤ SPEECH_ATTENUATION_MAX_DB（防过度抑制）
//   3. 增强降噪噪声削减 ≥ 系统降噪噪声削减 − ORDERING_MARGIN_DB（名副其实）
// 脉冲段与语音衰减只进报告，不设门槛（RNNoise 对脉冲噪声的弱项是已知模型局限）。
// 绝对 dB 只进报告（stdout 对比表），不设绝对门槛。
//
// 阈值按基线实测标定（见文件头常量注释），stdout 始终打印三档对比表。

import { expect, test, type Page } from '@playwright/test'
import { createGuildMember, deletePlatformUser, firstJoinedGuildID } from './api-helpers'
import {
  FIXTURE_SAMPLE_RATE,
  FIXTURE_WINDOWS,
  generateFixtureFrames,
} from './noise-fixture'

// 门禁阈值（基线标定：2026-08 本地 Compose 环境三档基线跑 3 轮，增强降噪噪声
// 削减 8.8~19.8dB（会话间波动）、语音衰减 ~0dB、系统降噪 ~0dB）。阈值取最差
// 轮的折扣值，避免无头环境会话间波动造成假失败。见 spec.md 测试决策节。
const NOISE_REDUCTION_MIN_DB = 6
const SPEECH_ATTENUATION_MAX_DB = 3
const ORDERING_MARGIN_DB = 3

// 录制 22s：跳过前 4s（预热/对齐边界）后剩余 18s ≥ 循环 14s + 段窗 2.8s，
// 保证任意相位下每段窗口都有一次完整出现。
const RECORD_MS = 22_000
const SETTLE_MS = 4_000

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8080'
const adminUsername = process.env.E2E_USERNAME ?? 'admin'
const adminPassword = process.env.E2E_PASSWORD ?? 'admin-password-123'
const runVoiceTest = process.env.E2E_LIVEKIT === '1'

interface OptionMeasurement {
  option: 'rnnoise' | 'webrtc' | 'off'
  noiseDb: number
  speechDb: number
  pulseDb: number
}

test('三档降噪选项的客观降噪测量与门禁', async ({ browser, request }, testInfo) => {
  test.skip(!runVoiceTest, '需要已运行的 LiveKit Compose 环境')
  test.setTimeout(240_000)

  await request.post('/api/auth/login', { data: { username: adminUsername, password: adminPassword } })
  const guildID = await firstJoinedGuildID(request)
  const suffix = `${Date.now().toString(36)}_${testInfo.project.name.startsWith('android') ? 'm' : 'd'}`
  const account = {
    username: `noise_measure_${suffix}`,
    displayName: `降噪测量${suffix.slice(-5)}`,
    password: 'noise-measure-password',
  }
  const accountID = (await createGuildMember(request, guildID, account)).id
  const context = await browser.newContext({ permissions: ['microphone'] })
  await context.grantPermissions(['microphone'], { origin: baseURL })
  // headless Chromium 的默认音频设备采样率为 44.1kHz，RNNoise 仅支持 48kHz
  // 上下文（createRnnoiseNode 对非 48kHz 返回 null→回退到系统降噪），会导致
  // 测量永远测不到增强降噪。测试会话内强制 AudioContext 为 48kHz（Chrome
  // 按显式 sampleRate 重采样），等价于真实 48kHz 输出设备环境。
  await context.addInitScript(() => {
    const OriginalAudioContext = window.AudioContext
    if (OriginalAudioContext && !(window as { __cwsForcedRate?: boolean }).__cwsForcedRate) {
      ;(window as { __cwsForcedRate?: boolean }).__cwsForcedRate = true
      window.AudioContext = class extends OriginalAudioContext {
        constructor(options?: AudioContextOptions) {
          super({ ...options, sampleRate: 48_000 })
        }
      }
    }
  })
  const page = await context.newPage()

  try {
    await loginVoicePage(page, account)
    await installDestinationTapper(page)
    await page.getByRole('button', { name: /语音频道/ }).click()
    await page.getByText('语音已连接', { exact: true }).waitFor({ timeout: 20_000 })
    await page.waitForTimeout(SETTLE_MS)

    const measurements: OptionMeasurement[] = []
    for (const option of ['rnnoise', 'webrtc', 'off'] as const) {
      if (option !== 'rnnoise') {
        // 切换选项会重建采集轨并创建新的管线 destination。
        const destinationCount = await destinationCountOf(page)
        await selectNoiseSuppressionOption(page, option)
        await expect.poll(() => destinationCountOf(page), { timeout: 20_000 }).toBeGreaterThan(destinationCount)
      }
      // 等待采集重建、AGC 收敛与降噪算法稳定（默认档无需等待重建，仅需算法稳定）。
      await page.waitForTimeout(SETTLE_MS)
      const samples = await recordDestination(page, RECORD_MS)
      const db = measureSegments(samples)
      measurements.push({ option, ...db })
    }

    const report = buildReport(measurements)
    printReport(report)

    const rnnoise = report.rnnoise
    const webrtc = report.webrtc
    // 录音 sanity：关闭档若为静音，说明文件假麦克风/拦截点未生效，后续指标无意义。
    expect(report.absolute.off.noiseDb).toBeGreaterThan(-100)
    // 会话内相对断言：三档同会话测量，共享同一环境状态。
    expect(rnnoise.noiseReduction).toBeGreaterThanOrEqual(NOISE_REDUCTION_MIN_DB)
    expect(rnnoise.speechAttenuation).toBeLessThanOrEqual(SPEECH_ATTENUATION_MAX_DB)
    expect(rnnoise.noiseReduction).toBeGreaterThanOrEqual(webrtc.noiseReduction - ORDERING_MARGIN_DB)
  } finally {
    await Promise.allSettled([
      page.getByTitle('断开语音', { exact: true }).click(),
      context.close(),
    ])
    await deletePlatformUser(request, accountID, account.username)
  }
})

// ---- 页面侧 ----

async function loginVoicePage(page: Page, account: { username: string; displayName: string; password: string }) {
  await page.goto(baseURL)
  await page.getByLabel('登录名').fill(account.username)
  await page.getByLabel('密码').fill(account.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('heading', { name: '文字聊天', exact: true }).waitFor()
  const changelog = page.getByRole('dialog', { name: '更新日志' })
  if (await changelog.isVisible()) await changelog.getByTitle('关闭').click()
}

async function installDestinationTapper(page: Page) {
  await page.evaluate(() => {
    const target = window as typeof window & { __cwsDestinations?: Array<{ dest: MediaStreamAudioDestinationNode; at: number }> }
    target.__cwsDestinations = []
    const original = AudioContext.prototype.createMediaStreamDestination
    AudioContext.prototype.createMediaStreamDestination = function patchedDestination(this: AudioContext) {
      const dest = original.call(this)
      target.__cwsDestinations?.push({ dest, at: performance.now() })
      return dest
    }
  })
}

async function destinationCountOf(page: Page) {
  return page.evaluate(() => (window as typeof window & { __cwsDestinations?: unknown[] }).__cwsDestinations?.length ?? 0)
}

async function selectNoiseSuppressionOption(page: Page, option: string) {
  await page.getByTitle('用户账户').click()
  await page.getByRole('menu', { name: '用户账户操作' }).getByRole('menuitem', { name: '用户设置', exact: true }).click()
  await page.getByRole('dialog', { name: '用户设置' }).getByRole('button', { name: '音频', exact: true }).click()
  await page.getByLabel('降噪选项').selectOption(option)
  await page.getByRole('dialog', { name: '用户设置' }).getByTitle('关闭').click()
}

// 录制用 ScriptProcessorNode（无需 addModule/网络获取，不受 CSP 限制；
// 已废弃但 Chromium 仍稳定支持，测试环境可接受）。汇点用 MediaStreamDestination
// 而非 context.destination：不向扬声器播放，避免给 AEC 制造回声参考。
async function recordDestination(page: Page, ms: number): Promise<Float32Array> {
  return page.evaluate(async ({ ms }) => {
    const target = window as typeof window & { __cwsDestinations?: Array<{ dest: MediaStreamAudioDestinationNode; at: number }> }
    const destination = target.__cwsDestinations?.at(-1)?.dest
    if (!destination) throw new Error('未找到管线 destination')
    const context = new AudioContext({ sampleRate: 48000 })
    const source = context.createMediaStreamSource(destination.stream)
    const chunks: Float32Array[] = []
    const processor = context.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      const chunk = new Float32Array(input.length)
      chunk.set(input)
      chunks.push(chunk)
    }
    source.connect(processor)
    processor.connect(context.createMediaStreamDestination())
    await context.resume()
    await new Promise((resolve) => setTimeout(resolve, ms))
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const samples = new Float32Array(total)
    let offset = 0
    for (const chunk of chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    source.disconnect()
    processor.disconnect()
    await context.close()
    return samples
  }, { ms })
}

// ---- 分析（Node 侧）----

// 10ms 包络：hop 采样 RMS。相位用"录制包络 vs fixture 包络"互相关峰值定位，
// 语音段与脉冲段在信号中能量显著，互相关峰足够锐利。
const ENVELOPE_HOP = 480

function envelope(frames: Float32Array): Float32Array {
  const count = Math.floor(frames.length / ENVELOPE_HOP)
  const result = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    let sum = 0
    const base = i * ENVELOPE_HOP
    for (let j = 0; j < ENVELOPE_HOP; j++) {
      const value = frames[base + j]
      sum += value * value
    }
    result[i] = Math.sqrt(sum / ENVELOPE_HOP)
  }
  return result
}

// 返回录制样本 index 对应 fixture 样本 index 的相位偏移（samples）：
// fixtureIndex(recIndex) = (recIndex - phaseOffset) mod loopLength。
// 用归一化互相关（零均值/单位标准差）——录制信号经降噪后大部分时段安静，
// 原始互相关会被"均值乘积"淹没、峰值平坦，归一化后语音段尖峰才突显。
function alignPhase(recorded: Float32Array, fixture: Float32Array): number {
  const recordedEnv = envelope(recorded)
  const fixtureEnv = envelope(fixture)
  const loopLength = Math.floor(fixture.length / ENVELOPE_HOP)
  const meanR = recordedEnv.reduce((sum, value) => sum + value, 0) / recordedEnv.length
  const meanF = fixtureEnv.reduce((sum, value) => sum + value, 0) / fixtureEnv.length
  const stdR = Math.sqrt(recordedEnv.reduce((sum, value) => sum + (value - meanR) ** 2, 0) / recordedEnv.length)
  const stdF = Math.sqrt(fixtureEnv.reduce((sum, value) => sum + (value - meanF) ** 2, 0) / fixtureEnv.length)
  let bestLag = 0
  let bestScore = -Infinity
  for (let lag = 0; lag < loopLength; lag++) {
    let score = 0
    let count = 0
    for (let i = 0; i < fixtureEnv.length; i++) {
      const j = i + lag
      if (j >= recordedEnv.length) break
      score += ((recordedEnv[j] - meanR) / stdR) * ((fixtureEnv[i] - meanF) / stdF)
      count++
    }
    const normalized = count > 0 ? score / count : -Infinity
    if (normalized > bestScore) {
      bestScore = normalized
      bestLag = lag
    }
  }
  return bestLag * ENVELOPE_HOP
}

function rmsDb(frames: Float32Array, from: number, to: number): number {
  const fromSample = Math.max(0, Math.floor(from))
  const toSample = Math.min(frames.length, Math.floor(to))
  if (toSample - fromSample < 1000) return -120
  let sum = 0
  for (let i = fromSample; i < toSample; i++) {
    const value = frames[i]
    sum += value * value
  }
  return 20 * Math.log10(Math.sqrt(sum / (toSample - fromSample)) + 1e-9)
}

function measureSegments(recorded: Float32Array): Omit<OptionMeasurement, 'option'> {
  const fixture = generateFixtureFrames()
  const phaseOffset = alignPhase(recorded, fixture)
  const loopLength = fixture.length

  const windowAt = (fixtureFrom: number, fixtureTo: number): number | null => {
    // 映射 rec ≡ windowStart + phaseOffset (mod loop)。循环起点必须取 loop
    // 的整数倍（skip 本身不是 loop 倍数，直接加会引入恒定的相位偏移，导致
    // 窗口整体错位到下一段）。取第一个 ≥ skip 且窗口完整的出现。
    const skip = 4 * FIXTURE_SAMPLE_RATE
    const windowStartInLoop = Math.floor(fixtureFrom * FIXTURE_SAMPLE_RATE)
    const windowLen = Math.floor((fixtureTo - fixtureFrom) * FIXTURE_SAMPLE_RATE)
    const windowStartRec = ((windowStartInLoop + phaseOffset) % loopLength + loopLength) % loopLength
    for (let start = skip - (skip % loopLength); start + windowLen <= recorded.length; start += loopLength) {
      const recStart = start + windowStartRec
      if (recStart >= skip && recStart + windowLen <= recorded.length) {
        return recStart
      }
    }
    return null
  }

  const segments: Array<keyof typeof FIXTURE_WINDOWS> = ['noise', 'speech', 'pulse']
  const result: { noiseDb: number; speechDb: number; pulseDb: number } = { noiseDb: 0, speechDb: 0, pulseDb: 0 }
  for (const segment of segments) {
    const [from, to] = FIXTURE_WINDOWS[segment]
    const recStart = windowAt(from, to)
    if (recStart === null) {
      throw new Error(`段窗口 ${segment} 未在录制中找到（录制过短或相位定位失败）`)
    }
    result[`${segment}Db`] = rmsDb(recorded, recStart, recStart + (to - from) * FIXTURE_SAMPLE_RATE)
  }
  return result
}

function buildReport(measurements: OptionMeasurement[]) {
  const byOption = Object.fromEntries(measurements.map((m) => [m.option, m])) as Record<'rnnoise' | 'webrtc' | 'off', OptionMeasurement>
  const off = byOption.off
  const summary = (option: OptionMeasurement) => ({
    // 噪声削减/语音衰减/脉冲削减 = 该档相对"关闭"档的 dB 变化（正值 = 削减）。
    noiseReduction: off.noiseDb - option.noiseDb,
    speechAttenuation: off.speechDb - option.speechDb,
    pulseReduction: off.pulseDb - option.pulseDb,
  })
  return { rnnoise: summary(byOption.rnnoise), webrtc: summary(byOption.webrtc), off: summary(off), absolute: byOption }
}

function printReport(report: ReturnType<typeof buildReport>) {
  const row = (name: string, value: { noiseReduction: number; speechAttenuation: number; pulseReduction: number }) =>
    `${name.padEnd(9)} 噪声削减 ${value.noiseReduction.toFixed(1).padStart(6)} dB | 语音衰减 ${value.speechAttenuation.toFixed(1).padStart(6)} dB | 脉冲削减 ${value.pulseReduction.toFixed(1).padStart(6)} dB`
  const abs = (name: string, value: { noiseDb: number; speechDb: number; pulseDb: number }) =>
    `${name.padEnd(9)} 噪声段 ${value.noiseDb.toFixed(1).padStart(7)} dB | 语音段 ${value.speechDb.toFixed(1).padStart(7)} dB | 脉冲段 ${value.pulseDb.toFixed(1).padStart(7)} dB`
  console.log('降噪测量（相对关闭档削减量）：')
  console.log(row('关闭', report.off))
  console.log(row('系统降噪', report.webrtc))
  console.log(row('增强降噪', report.rnnoise))
  console.log('各档绝对段电平：')
  console.log(abs('关闭', report.absolute.off))
  console.log(abs('系统降噪', report.absolute.webrtc))
  console.log(abs('增强降噪', report.absolute.rnnoise))
}
