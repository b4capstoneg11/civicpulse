/**
 * A Google Maps link that starts navigation to a reported issue.
 *
 * `dir/?api=1` opens directions rather than a dropped pin, which is what a crew
 * on the way to a job actually needs — on a phone it hands off to the Maps app
 * and starts routing from wherever they are. Keyless, and the only Google
 * dependency in the product: a URL, not an API.
 *
 * The destination is coordinates, never the geocoded address. The address can be
 * null when Nominatim finds nothing, and even when present it is a suburb-level
 * name that would route a crew to the middle of an area rather than to the
 * pothole. Six decimals to match what the ticket displays.
 */
export function mapsDirectionsUrl(lat: number, lon: number): string {
  const destination = encodeURIComponent(`${lat.toFixed(6)},${lon.toFixed(6)}`)
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}`
}

export interface ReverseGeocodeResult {
  pincode: string | null
  area: string | null
  city: string | null
  state: string | null
}

/**
 * Reverse geocodes coordinates to PIN code / area / city / state using the
 * free OpenStreetMap Nominatim API. No API key required; keep request volume
 * low per Nominatim's usage policy.
 */
export async function reverseGeocode(lat: number, lon: number): Promise<ReverseGeocodeResult> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    return { pincode: null, area: null, city: null, state: null }
  }
  const data = await response.json()
  const address = data.address ?? {}
  return {
    pincode: address.postcode ?? null,
    area: address.suburb ?? address.neighbourhood ?? address.village ?? address.town ?? null,
    city: address.city ?? address.town ?? address.county ?? null,
    state: address.state ?? null,
  }
}
