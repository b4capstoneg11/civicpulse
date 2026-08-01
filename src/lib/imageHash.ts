/**
 * Client-side perceptual hash (dHash) used for duplicate-report detection.
 * Resizes the image to 9x8 grayscale and compares adjacent pixel brightness,
 * producing a 64-bit hash as a hex string. Hamming distance between two
 * hashes approximates visual similarity.
 */
export async function computeImageHash(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const width = 9
  const height = 8

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')

  ctx.drawImage(bitmap, 0, 0, width, height)
  const { data } = ctx.getImageData(0, 0, width, height)

  const gray: number[] = []
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
    gray.push(0.299 * r + 0.587 * g + 0.114 * b)
  }

  let bits = ''
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width - 1; col++) {
      const left = gray[row * width + col]
      const right = gray[row * width + col + 1]
      bits += left > right ? '1' : '0'
    }
  }

  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  }
  return hex
}

export function hammingDistance(hexA: string, hexB: string): number {
  if (hexA.length !== hexB.length) return Number.MAX_SAFE_INTEGER
  let distance = 0
  for (let i = 0; i < hexA.length; i++) {
    const xor = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16)
    distance += xor.toString(2).split('1').length - 1
  }
  return distance
}
