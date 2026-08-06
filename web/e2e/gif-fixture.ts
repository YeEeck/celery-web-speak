// GIF 头像上传 e2e 的 fixture：确定性的 2 帧 8×8 动画 GIF 构建器，由
// playwright.config.ts 生成落盘（与 noise-fixture 同模式），供头像上传用例
// 使用——客户端应旁路裁剪器原样上传，服务端按 image/gif 原字节存储。

const WIDTH = 8
const HEIGHT = 8
const FRAME_DELAY_CENTISECONDS = 10

// lzwEncode 输出 GIF 的 LZW 压缩图像数据（最小码长 2）。像素流按
// palette 索引给出；码长增长与 Go compress/lzw 解码器对齐——解码器在
// 已处理码数使下一个表项槽号达到 2^码长 时切换宽度，编码器须在表项
// 槽号达到 2^码长 + 1 时切换，恰好晚一个码（即"写出第 3 个码后才加宽"）。
// 单字符（字面量）直接对应码 0..2^n-1，预置进字典，不再占表项槽位。
function lzwEncode(pixels: number[]): number[] {
  const minCodeSize = 2
  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1
  let nextCode = eoiCode + 1
  let codeSize = minCodeSize + 1
  const dict = new Map<string, number>()
  for (let literal = 0; literal < 1 << minCodeSize; literal++) {
    dict.set(String.fromCharCode(literal), literal)
  }
  let current = ''
  const out: number[] = []
  let bitBuf = 0
  let bitCount = 0
  const writeCode = (code: number) => {
    bitBuf |= code << bitCount
    bitCount += codeSize
    while (bitCount >= 8) {
      out.push(bitBuf & 0xff)
      bitBuf >>>= 8
      bitCount -= 8
    }
  }
  writeCode(clearCode)
  for (const pixel of pixels) {
    const key = current + String.fromCharCode(pixel)
    if (dict.has(key)) {
      current = key
    } else {
      writeCode(dict.get(current)!)
      dict.set(key, nextCode++)
      if (nextCode === (1 << codeSize) + 1 && codeSize < 12) codeSize++
      current = String.fromCharCode(pixel)
    }
  }
  writeCode(dict.get(current)!)
  writeCode(eoiCode)
  if (bitCount > 0) out.push(bitBuf & 0xff)
  return out
}

// 单帧:graphic control extension + 图像描述符 + LZW 数据子块(按 255 分块)。
function frameData(frameIndex: number): number[] {
  const pixels: number[] = []
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) pixels.push((x + y + frameIndex) % 2)
  }
  const lzw = lzwEncode(pixels)
  const blocks: number[] = []
  for (let offset = 0; offset < lzw.length; offset += 255) {
    const chunk = lzw.slice(offset, offset + 255)
    blocks.push(chunk.length, ...chunk)
  }
  return [
    0x21, 0xf9, 0x04, 0x00,
    FRAME_DELAY_CENTISECONDS & 0xff, FRAME_DELAY_CENTISECONDS >> 8,
    0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, WIDTH, 0x00, HEIGHT, 0x00, 0x00,
    0x02, ...blocks, 0x00,
  ]
}

export function buildGifAvatarFixture(): Uint8Array {
  // GIF89a 头 + 逻辑屏幕描述符(全局色表 2 色) + 全局色表(红/蓝)。
  const bytes: number[] = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    WIDTH, 0x00, HEIGHT, 0x00, 0x80, 0x00, 0x00,
    0xea, 0x33, 0x2d, 0x00, 0x2e, 0xcc,
    ...frameData(0),
    ...frameData(1),
    0x3b,
  ]
  return new Uint8Array(bytes)
}
