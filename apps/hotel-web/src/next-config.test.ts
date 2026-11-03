import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

// The security headers in next.config.ts: only /prijava may load Cloudflare
// Turnstile. Next keeps the later of two rules that set the same header for a
// path, so the /prijava rule must come after the general one.
type Rule = { source: string; headers: Array<{ key: string; value: string }> };

async function rules(): Promise<Rule[]> {
  return (await nextConfig.headers!()) as Rule[];
}

function cspOf(rule: Rule | undefined): string {
  const value = rule?.headers.find((h) => h.key === 'Content-Security-Policy')?.value;
  if (!value) throw new Error(`no CSP in ${rule?.source}`);
  return value;
}

/** The policy Next sends for `path`: the last matching rule with a CSP wins. */
async function cspFor(path: string): Promise<string> {
  const matching = (await rules()).filter((r) =>
    r.source === '/:path*' ? true : r.source === path,
  );
  const withCsp = matching.filter((r) => r.headers.some((h) => h.key === 'Content-Security-Policy'));
  return cspOf(withCsp[withCsp.length - 1]);
}

function directive(csp: string, name: string): string {
  return csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';
}

describe('next.config headers', () => {
  it('/prijava admits challenges.cloudflare.com in script-src and frame-src', async () => {
    const csp = await cspFor('/prijava');
    expect(directive(csp, 'script-src')).toContain('https://challenges.cloudflare.com');
    expect(directive(csp, 'frame-src')).toBe('frame-src https://challenges.cloudflare.com');
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
  });

  it('/kalendar (and every other page) does not', async () => {
    const csp = await cspFor('/kalendar');
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('challenges.cloudflare.com');
    expect(directive(csp, 'frame-src')).toBe('');
  });

  it('the /prijava rule comes after the general one, so it is the one Next keeps', async () => {
    const sources = (await rules()).map((r) => r.source);
    expect(sources).toContain('/:path*');
    expect(sources).toContain('/prijava');
    expect(sources.indexOf('/prijava')).toBeGreaterThan(sources.indexOf('/:path*'));
  });

  it('the general rule keeps the other security headers', async () => {
    const general = (await rules()).find((r) => r.source === '/:path*')!;
    expect(general.headers.map((h) => h.key)).toEqual(
      expect.arrayContaining(['Content-Security-Policy', 'X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy']),
    );
  });
});
