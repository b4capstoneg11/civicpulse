/**
 * Spots a likely mistyped email domain and offers the intended one.
 *
 * Format checks cannot help here: gmial.com, yaho.com and gmail.co are all
 * perfectly well-formed, and a staff account created against one is a colleague
 * who can never be reached. Nothing in the creation flow sends to the address,
 * so the mistake stays invisible until someone needs a password reset.
 *
 * A suggestion, never a block. A false positive that stopped someone adding a
 * real colleague would be worse than the typo it prevented.
 */

/**
 * Ordinary consumer domains, plus the Indian ones this project actually sees.
 * Deliberately short — a longer list means more chances to "correct" a real
 * domain into the wrong one.
 */
const KNOWN_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'yahoo.in',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'protonmail.com',
  'proton.me',
  'aol.com',
  'rediffmail.com',
  'zoho.com',
]

/**
 * Damerau-Levenshtein (optimal string alignment) rather than plain Levenshtein,
 * because transposition is the single most common typing error and plain edit
 * distance charges two for it. "gmial" to "gmail" is one swap, and counting it
 * as two would push it past the threshold for shorter domains.
 */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const d: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0))

  for (let i = 0; i < rows; i++) d[i][0] = i
  for (let j = 0; j < cols; j++) d[0][j] = j

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost // substitution
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost) // transposition
      }
    }
  }

  return d[a.length][b.length]
}

/**
 * Returns the corrected address, or null when there is nothing worth saying.
 *
 * Null covers three cases that all mean "leave them alone": the address has no
 * domain yet, the domain is already one we recognise, or it resembles nothing
 * on the list — which is what an institutional address like @iitp.ac.in should
 * do.
 */
export function suggestEmailDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at < 1 || at === email.length - 1) return null

  const local = email.slice(0, at)
  const domain = email.slice(at + 1).toLowerCase()
  if (KNOWN_DOMAINS.includes(domain)) return null

  let best: string | null = null
  let bestDistance = Infinity
  for (const known of KNOWN_DOMAINS) {
    const distance = editDistance(domain, known)
    if (distance < bestDistance) {
      bestDistance = distance
      best = known
    }
  }

  // Short domains sit close to several others, so they get the tighter
  // threshold: at a distance of two, aol.com is "near" more than one candidate
  // and the guess stops being useful.
  const limit = domain.length <= 8 ? 1 : 2
  if (best && bestDistance > 0 && bestDistance <= limit) return `${local}@${best}`
  return null
}
