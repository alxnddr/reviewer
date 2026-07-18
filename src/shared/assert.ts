/** Exhaustiveness proof for `switch` over a discriminated union: unreachable at runtime
 * unless a variant was added without handling it. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
