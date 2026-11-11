/**
 * Only an answer of exactly `true` passes. Anything else is a no: `false`, a truthy value such as the string
 * `'false'` from an environment variable, `1` or an object, and an error thrown or rejected (so a broken check
 * refuses with a 403, never a 500).
 */
export async function exactlyTrue(check: () => unknown): Promise<boolean> {
  try {
    return (await check()) === true
  } catch {
    return false
  }
}

/** The same rule for a check that must answer at once, such as `allow()`: a promise is not `true`, so it's a no. */
export function exactlyTrueNow(check: () => unknown): boolean {
  try {
    return check() === true
  } catch {
    return false
  }
}
