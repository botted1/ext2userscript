// Reads results that probes leave on <html> attributes. DOM attributes are shared between the page world
// and a userscript's isolated world, so this works on every backend.
import type { Page } from "playwright";

export const readAttr = (page: Page, name: string): Promise<string | null> => page.locator("html").getAttribute(name);

export async function waitForAttr(page: Page, name: string, expected: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let last: string | null = null;
  while ((last = await readAttr(page, name)) !== expected) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout}ms waiting for <html ${name}="${expected}"> (last value: ${last})`);
    await page.waitForTimeout(100);
  }
}

export async function waitForJson<T>(page: Page, name: string, ok: (value: T) => boolean = () => true, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const raw = await readAttr(page, name);
    if (raw !== null) {
      const value = JSON.parse(raw) as T;
      if (ok(value)) return value;
    }
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout}ms waiting for <html ${name}> (last value: ${raw})`);
    await page.waitForTimeout(100);
  }
}
