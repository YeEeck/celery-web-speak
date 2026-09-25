// 让 Web Audio 图继续被调度，但不打开扬声器。分析用节点（VAD worklet、
// analyser）必须接到一个 destination 才会跑；接到 context.destination 即
// 使 gain=0 也会在安卓上占用一条播放流，与语音混音抢 HAL（ADR-0045）。

export function connectWithoutPlayback(context: AudioContext, node: AudioNode): MediaStreamAudioDestinationNode {
  const tap = context.createMediaStreamDestination()
  node.connect(tap)
  return tap
}

export function disconnectSilentTap(
  node: AudioNode | null | undefined,
  tap: MediaStreamAudioDestinationNode | null | undefined,
) {
  node?.disconnect()
  tap?.disconnect()
  tap?.stream.getTracks().forEach((track) => track.stop())
}
