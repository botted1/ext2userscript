export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until check() is true, or throws after timeoutMs. */
export async function eventually(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs}ms`);
    await sleep(5);
  }
}
