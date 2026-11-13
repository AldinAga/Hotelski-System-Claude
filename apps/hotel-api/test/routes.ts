import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { LICENSED_ACTION, UNLICENSED, type LicensedActionMeta } from '../src/licensing/licensed-action';

/** The actions phase 1b added (the specs that pin 1b routes share this one pattern). */
export const ACTIONS_1B = /^(guest\.|stay\.check_|folio\.|business_day\.|settings\.|legal_profile\.|message\.)/;

export interface RouteInfo {
  route: string;
  /** HTTP method name, e.g. 'GET'. */
  method: string;
  /** Full path with Nest's ':param' placeholders, e.g. '/stays/:id/folio'. */
  path: string;
  /** Neither @LicensedAction nor @Unlicensed on the handler or its controller. */
  annotated: boolean;
  /** The licence module and action the route performs (the handler's wins over its controller's); undefined when unlicensed or unannotated. */
  module?: string;
  action?: string;
}

/**
 * Every route handler of the running app, found through Nest's own discovery
 * (the app must import DiscoveryModule). Read independently of LicenceGuard:
 * this checks the metadata keys directly.
 */
export function discoverRoutes(app: INestApplication): RouteInfo[] {
  const discovery = app.get(DiscoveryService);
  const scanner = new MetadataScanner();
  const routes: RouteInfo[] = [];
  for (const wrapper of discovery.getControllers()) {
    const controller = wrapper.metatype as (new () => object) | undefined;
    if (!controller) continue;
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = proto[name] as object;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (path === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      const has = (key: string) =>
        Reflect.getMetadata(key, handler) !== undefined || Reflect.getMetadata(key, controller) !== undefined;
      const full = `/${Reflect.getMetadata(PATH_METADATA, controller) ?? ''}/${path}`
        .replace(/\/+/g, '/')
        .replace(/(.)\/$/, '$1');
      const meta =
        (Reflect.getMetadata(LICENSED_ACTION, handler) as LicensedActionMeta | undefined) ??
        (Reflect.getMetadata(LICENSED_ACTION, controller) as LicensedActionMeta | undefined);
      routes.push({
        route: `${method} ${full} (${controller.name}.${name})`,
        method,
        path: full,
        annotated: has(LICENSED_ACTION) || has(UNLICENSED),
        module: meta?.module,
        action: meta?.action,
      });
    }
  }
  return routes;
}

/** Every @LicensedAction (method or controller level) of the running app, one entry per annotation. */
export function licensedActions(app: INestApplication): Array<LicensedActionMeta & { where: string }> {
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

/** Route layers Express actually serves: a cross-check that discovery missed nothing. */
export function expressRouteCount(app: INestApplication): number {
  const instance = app.getHttpAdapter().getInstance() as { _router: { stack: Array<{ route?: unknown }> } };
  return instance._router.stack.filter((layer) => layer.route !== undefined).length;
}
