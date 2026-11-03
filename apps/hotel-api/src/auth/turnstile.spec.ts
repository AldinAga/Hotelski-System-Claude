import { loadTurnstileConfig, SITEVERIFY_URL, SITEVERIFY_TIMEOUT_MS } from './turnstile';

// The switch: Turnstile is on only when both keys are present. One key alone
// is a half-done configuration: it stays off and the log names the missing
// variable, never a value.
describe('loadTurnstileConfig', () => {
  const SITE = '0x4AAAAAAAsite-value';
  const SECRET = '0x4AAAAAAAsecret-value';

  function load(env: Record<string, string | undefined>) {
    const lines: string[] = [];
    const config = loadTurnstileConfig(env, (line) => lines.push(line));
    return { config, lines };
  }

  it('neither key: off, nothing logged', () => {
    const { config, lines } = load({});
    expect(config).toBeNull();
    expect(lines).toEqual([]);
  });

  it('both keys: on, with Cloudflare siteverify and a 5 s timeout', () => {
    const { config, lines } = load({ TURNSTILE_SITE_KEY: ` ${SITE} `, TURNSTILE_SECRET_KEY: SECRET });
    expect(config).toEqual({
      siteKey: SITE,
      secretKey: SECRET,
      verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      timeoutMs: 5000,
      hostnames: null,
    });
    expect(SITEVERIFY_URL).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(SITEVERIFY_TIMEOUT_MS).toBe(5000);
    expect(lines).toEqual([]);
  });

  it('the verify URL cannot be moved through the environment', () => {
    const { config } = load({
      TURNSTILE_SITE_KEY: SITE,
      TURNSTILE_SECRET_KEY: SECRET,
      TURNSTILE_VERIFY_URL: 'http://evil.example/siteverify',
    });
    expect(config?.verifyUrl).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  });

  it.each([
    ['TURNSTILE_SECRET_KEY', { TURNSTILE_SITE_KEY: SITE }],
    ['TURNSTILE_SITE_KEY', { TURNSTILE_SECRET_KEY: SECRET }],
    ['TURNSTILE_SECRET_KEY', { TURNSTILE_SITE_KEY: SITE, TURNSTILE_SECRET_KEY: '   ' }],
  ])('only one key: off, and the log names %s without any value', (missing, env) => {
    const { config, lines } = load(env);
    expect(config).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(missing);
    expect(lines[0]).not.toContain(SITE);
    expect(lines[0]).not.toContain(SECRET);
  });

  it('TURNSTILE_HOSTNAMES: a lower-cased list; blank is no check', () => {
    const both = { TURNSTILE_SITE_KEY: SITE, TURNSTILE_SECRET_KEY: SECRET };
    expect(load({ ...both, TURNSTILE_HOSTNAMES: ' Recepcija.Hotel.rs, ,192.168.1.199 ' }).config?.hostnames).toEqual([
      'recepcija.hotel.rs',
      '192.168.1.199',
    ]);
    expect(load({ ...both, TURNSTILE_HOSTNAMES: '  ' }).config?.hostnames).toBeNull();
  });
});
