import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { LICENSED_ACTION, LicensedAction, type LicensedActionMeta } from '../src/licensing/licensed-action';
import { SAFE_MODE_ALLOWED } from '../src/licensing/safe-mode';
import { createTestApp, type TestApp } from './app';

// The product manifest is the contract with the Central Admin Panel (spec
// section 4). The oracle for its keys is the spec itself: the tables of
// sections 4.1 and 4.2 and the list of 4.3 are parsed here, independently of
// the manifest under test.

const ROOT = resolve(__dirname, '../../..');
const SPEC = readFileSync(resolve(ROOT, 'docs/specs/2026-10-10-hotel-system-design.md'), 'utf8');

interface ManifestModule {
  key: string;
  name: string;
  description?: string;
  depends_on: string[];
  core: boolean;
  remote_toggle: boolean;
  required_by_profile: string[];
}
interface KeyedType {
  key: string;
  name: string;
  unit: string;
}
interface Manifest {
  version: string;
  modules: ManifestModule[];
  limit_types: KeyedType[];
  metric_types: KeyedType[];
  expiry_modes: string[];
}

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'product/manifest.json'), 'utf8')) as Manifest;

function section(start: string, end: string): string {
  const from = SPEC.indexOf(start);
  const to = SPEC.indexOf(end, from + 1);
  if (from < 0 || to < 0) throw new Error(`spec section ${start} not found`);
  return SPEC.slice(from, to);
}

/** Rows of a spec table whose first cell is a `hotel.*` key: key and the "Zavisi od" cell. */
function specRows(text: string): Array<{ key: string; deps: string[] }> {
  const rows: Array<{ key: string; deps: string[] }> = [];
  for (const line of text.split('\n')) {
    const m = /^\| `(hotel\.[a-z0-9_]+)` \|/.exec(line);
    if (!m) continue;
    const cells = line.split('|').map((c) => c.trim());
    // ['', key, content, deps?, ''] — section 4.1 has no dependency column.
    const depsCell = cells.length >= 5 ? cells[3] : '';
    const deps = depsCell
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => `hotel.${d}`);
    rows.push({ key: m[1], deps });
  }
  return rows;
}

const CORE_ROWS = specRows(section('### 4.1', '### 4.2'));
const ADDON_ROWS = specRows(section('### 4.2', '### 4.3'));
const SPEC_ROWS = [...CORE_ROWS, ...ADDON_ROWS];
const SPEC_LIMITS = [...section('### 4.3', '### 4.4').matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);

// Same shapes the Admin Panel's validateManifest enforces (apps/admin-api/src/products/manifest.ts).
const KEY = /^[a-z][a-z0-9_.]{1,63}$/;
const SEMVER = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const MODULE_FIELDS = ['key', 'name', 'description', 'depends_on', 'core', 'remote_toggle', 'required_by_profile'];
const TOP_FIELDS = ['version', 'modules', 'limit_types', 'metric_types', 'expiry_modes'];

/** Cycles in depends_on, each as the path that closes it. */
function cyclesOf(modules: ManifestModule[]): string[][] {
  const byKey = new Map(modules.map((m) => [m.key, m]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (key: string): void => {
    state.set(key, 'visiting');
    stack.push(key);
    for (const dep of byKey.get(key)?.depends_on ?? []) {
      if (!byKey.has(dep)) continue;
      if (state.get(dep) === 'visiting') cycles.push([...stack.slice(stack.indexOf(dep)), dep]);
      else if (!state.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(key, 'done');
  };
  for (const m of modules) if (!state.has(m.key)) visit(m.key);
  return cycles;
}

/** Every @LicensedAction (method or controller level) of the running app. */
function licensedActions(app: INestApplication): Array<LicensedActionMeta & { where: string }> {
  const discovery = app.get(DiscoveryService);
  const scanner = new MetadataScanner();
  const found: Array<LicensedActionMeta & { where: string }> = [];
  for (const wrapper of discovery.getControllers()) {
    const controller = wrapper.metatype as (new () => object) | undefined;
    if (!controller) continue;
    const onClass = Reflect.getMetadata(LICENSED_ACTION, controller) as LicensedActionMeta | undefined;
    if (onClass) found.push({ ...onClass, where: controller.name });
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(proto)) {
      const meta = Reflect.getMetadata(LICENSED_ACTION, proto[name] as object) as LicensedActionMeta | undefined;
      if (meta) found.push({ ...meta, where: `${controller.name}.${name}` });
    }
  }
  return found;
}

/** Licensed actions whose module is not in the manifest. */
function unknownModules(actions: Array<LicensedActionMeta & { where: string }>): string[] {
  const keys = new Set(manifest.modules.map((m) => m.key));
  return actions.filter((a) => !keys.has(a.module)).map((a) => `${a.where}: ${a.module}`);
}

// Positive control for the scan: a route on a module the manifest never had.
@Controller('manifest-probe')
class ProbeController {
  @Get()
  @LicensedAction('hotel.not_in_manifest', 'probe.view')
  probe(): string {
    return 'x';
  }
}

describe('product manifest', () => {
  it('the spec oracle itself was read: 3 core modules, 15 add-ons, 8 limits', () => {
    expect(CORE_ROWS.map((r) => r.key)).toEqual(['hotel.core', 'hotel.folio', 'hotel.eturista']);
    expect(ADDON_ROWS).toHaveLength(15);
    expect(ADDON_ROWS.find((r) => r.key === 'hotel.owners')?.deps).toEqual(['hotel.folio', 'hotel.rentals']);
    expect(SPEC_LIMITS).toEqual([
      'rooms',
      'users',
      'devices',
      'lock_encoders',
      'website_languages',
      'gallery_storage_gb',
      'owners',
      'installations',
    ]);
  });

  it('has the Admin Panel shape: known fields, x.y.z version 0.1.0, safe_mode expiry, no metrics', () => {
    expect(Object.keys(manifest).sort()).toEqual([...TOP_FIELDS].sort());
    expect(manifest.version).toMatch(SEMVER);
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.expiry_modes).toEqual(['safe_mode']);
    expect(manifest.metric_types).toEqual([]);
    for (const m of manifest.modules) {
      expect(Object.keys(m).filter((f) => !MODULE_FIELDS.includes(f))).toEqual([]);
      expect(m.key).toMatch(KEY);
      expect(m.name.trim()).not.toBe('');
      expect(typeof m.core).toBe('boolean');
      expect(typeof m.remote_toggle).toBe('boolean');
      expect(Array.isArray(m.depends_on)).toBe(true);
      expect(Array.isArray(m.required_by_profile)).toBe(true);
    }
  });

  it('every key of the spec tables 4.1 and 4.2 is in the manifest exactly once, and nothing else', () => {
    const keys = manifest.modules.map((m) => m.key);
    for (const row of SPEC_ROWS) expect([row.key, keys.filter((k) => k === row.key).length]).toEqual([row.key, 1]);
    expect([...keys].sort()).toEqual(SPEC_ROWS.map((r) => r.key).sort());
  });

  it('depends_on is the "Zavisi od" column of the spec, and every dependency exists', () => {
    const keys = new Set(manifest.modules.map((m) => m.key));
    for (const row of SPEC_ROWS) {
      const m = manifest.modules.find((x) => x.key === row.key)!;
      expect([row.key, [...m.depends_on].sort()]).toEqual([row.key, [...row.deps].sort()]);
    }
    for (const m of manifest.modules) {
      for (const dep of m.depends_on) expect([m.key, dep, keys.has(dep)]).toEqual([m.key, dep, true]);
    }
  });

  it('has no dependency cycle', () => {
    expect(cyclesOf(manifest.modules)).toEqual([]);
    // The detector finds one when there is one.
    expect(
      cyclesOf([
        { key: 'a.x', name: 'x', depends_on: ['a.y'], core: false, remote_toggle: true, required_by_profile: [] },
        { key: 'a.y', name: 'y', depends_on: ['a.x'], core: false, remote_toggle: true, required_by_profile: [] },
      ]),
    ).toEqual([['a.x', 'a.y', 'a.x']]);
  });

  it('core is exactly core, folio and eturista; a core module rests only on core modules', () => {
    expect(manifest.modules.filter((m) => m.core).map((m) => m.key).sort()).toEqual(
      ['hotel.core', 'hotel.eturista', 'hotel.folio'].sort(),
    );
    const core = new Set(manifest.modules.filter((m) => m.core).map((m) => m.key));
    for (const m of manifest.modules.filter((x) => x.core)) {
      expect([m.key, m.depends_on.filter((d) => !core.has(d))]).toEqual([m.key, []]);
    }
    // Add-ons can be switched from the Admin Panel; the core cannot.
    for (const m of manifest.modules) expect([m.key, m.remote_toggle]).toEqual([m.key, !m.core]);
  });

  it('hotel.fiscal_rs is required for legal_entity and entrepreneur, and no other module is', () => {
    const fiscal = manifest.modules.find((m) => m.key === 'hotel.fiscal_rs')!;
    expect([...fiscal.required_by_profile].sort()).toEqual(['entrepreneur', 'legal_entity']);
    expect(manifest.modules.filter((m) => m.required_by_profile.length > 0).map((m) => m.key)).toEqual([
      'hotel.fiscal_rs',
    ]);
  });

  it('limit_types are the keys of spec 4.3, each with a name and a unit', () => {
    expect(manifest.limit_types.map((t) => t.key)).toEqual(SPEC_LIMITS);
    for (const t of manifest.limit_types) {
      expect(Object.keys(t).sort()).toEqual(['key', 'name', 'unit']);
      expect(t.name.trim()).not.toBe('');
      expect(t.unit.trim()).not.toBe('');
    }
  });

  describe('code uses only modules of the manifest', () => {
    let ta: TestApp;
    let probe: TestApp;

    beforeAll(async () => {
      ta = await createTestApp();
      probe = await createTestApp({ controllers: [ProbeController] });
    });
    afterAll(async () => {
      await ta?.app.close();
      await probe?.app.close();
    });

    it('every @LicensedAction names a manifest module', () => {
      const actions = licensedActions(ta.app);
      expect(unknownModules(actions)).toEqual([]);
      // Phase 1a has 20 licensed actions (19 routes plus the UsersController class); the scan must actually see them.
      expect(actions.length).toBeGreaterThanOrEqual(20);
    });

    it('the scan reports a route on a module outside the manifest', () => {
      expect(unknownModules(licensedActions(probe.app))).toEqual([
        'ProbeController.probe: hotel.not_in_manifest',
      ]);
    });

    // SAFE_MODE_ALLOWED lists actions, not modules (the resolver matches on the
    // action). Its entries reach a module only through the routes that use them:
    // each such route must be on a manifest module, and an entry no route uses
    // must be a known reservation, not a typo that silently allows nothing.
    // user.view is kept for the user list route that phase 1a does not have yet.
    const RESERVED_SAFE_ACTIONS = ['user.view'];

    it('SAFE_MODE_ALLOWED actions are served only on manifest modules; unused entries are known', () => {
      const actions = licensedActions(ta.app).filter((a) => SAFE_MODE_ALLOWED.has(a.action));
      expect(unknownModules(actions)).toEqual([]);
      const served = new Set(actions.map((a) => a.action));
      expect([...SAFE_MODE_ALLOWED].filter((action) => !served.has(action))).toEqual(RESERVED_SAFE_ACTIONS);
      expect(served.size).toBeGreaterThanOrEqual(4);
    });
  });
});
