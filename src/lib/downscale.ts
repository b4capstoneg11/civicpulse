/**
 * Shrinks a photo before it is sent for AI analysis.
 *
 * The report form used to base64-encode the camera's original file and post it
 * to the `analyze-issue` edge function. A current phone camera produces 3-8 MB
 * per shot and base64 adds another third, so submitting a report meant pushing
 * 4-11 MB of JSON over a mobile connection before anything else could happen.
 * That failed two different ways in practice: the upload stalling (the client
 * reports "Failed to send a request to the Edge Function", with no status code
 * because the request never completed) and the request arriving and being
 * rejected for size ("Edge Function returned a non-2xx status code").
 *
 * None of that resolution was ever used. OpenAI's vision endpoint downsamples
 * on its side, and the duplicate-detection hash is computed at 9x8 pixels
 * (`imageHash.ts`). 1600px on the long edge is far more than either needs, and
 * cuts a typical photo by roughly 10x.
 *
 * The *stored* photo is untouched — `ReportIssue` still uploads the original to
 * Storage, so staff and the resolution comparison keep full detail. Only the
 * copy sent for classification shrinks.
 */
const MAX_EDGE = 1600
const JPEG_QUALITY = 0.85

export interface DownscaledImage {
  /** Base64 payload with no data-URL prefix, ready for the edge function. */
  base64: string
  mediaType: string
}

function toBase64(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}

export async function downscaleForAnalysis(file: File): Promise<DownscaledImage> {
  const bitmap = await createImageBitmap(file)

  const longestEdge = Math.max(bitmap.width, bitmap.height)
  const scale = Math.min(1, MAX_EDGE / longestEdge)
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')

  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  // Always re-encode as JPEG, even when the image was already small enough: a
  // PNG screenshot of a pothole is lossless and can be larger than the photo it
  // depicts, and nothing downstream cares about the format.
  return {
    base64: toBase64(canvas.toDataURL('image/jpeg', JPEG_QUALITY)),
    mediaType: 'image/jpeg',
  }
}
