export function rangeProgressStyle(value: number, min: number, max: number) {
  const progress = max === min ? 0 : ((value - min) / (max - min)) * 100
  return `--range-progress: ${Math.min(100, Math.max(0, progress))}%`
}
