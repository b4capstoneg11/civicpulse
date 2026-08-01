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
