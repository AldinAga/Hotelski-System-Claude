import { afterEach, describe, expect, it } from 'vitest';
import { loadTurnstile, resetTurnstileLoader } from './turnstile';

const URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const scripts = () => [...document.querySelectorAll<HTMLScriptElement>('script')].filter((s) => s.src === URL);

afterEach(() => resetTurnstileLoader());

describe('loadTurnstile', () => {
  it('two calls before the script has loaded add one script and share one load', async () => {
    const first = loadTurnstile();
    const second = loadTurnstile();
    expect(scripts()).toHaveLength(1);
    expect(second).toBe(first);

    const api = { render: () => 'w', reset: () => undefined, remove: () => undefined };
    window.turnstile = api;
    scripts()[0].dispatchEvent(new Event('load'));
    await expect(first).resolves.toBe(api);
    // Loaded: later calls answer from window.turnstile without touching the page.
    await expect(loadTurnstile()).resolves.toBe(api);
    expect(scripts()).toHaveLength(1);
  });

  it('a script that fails to load is removed, so a later call can try again', async () => {
    const first = loadTurnstile();
    scripts()[0].dispatchEvent(new Event('error'));
    await expect(first).rejects.toThrow();
    expect(scripts()).toHaveLength(0);
    void loadTurnstile().catch(() => undefined);
    expect(scripts()).toHaveLength(1);
  });
});
