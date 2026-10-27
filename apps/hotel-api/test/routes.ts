import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { LICENSED_ACTION, UNLICENSED } from '../src/licensing/licensed-action';

export interface RouteInfo {
  route: string;
  /** Neither @LicensedAction nor @Unlicensed on the handler or its controller. */
  annotated: boolean;
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
      routes.push({
        route: `${method} ${full} (${controller.name}.${name})`,
        annotated: has(LICENSED_ACTION) || has(UNLICENSED),
      });
    }
  }
  return routes;
}

/** Route layers Express actually serves: a cross-check that discovery missed nothing. */
export function expressRouteCount(app: INestApplication): number {
  const instance = app.getHttpAdapter().getInstance() as { _router: { stack: Array<{ route?: unknown }> } };
  return instance._router.stack.filter((layer) => layer.route !== undefined).length;
}
