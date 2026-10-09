import { ROUTES, store, type Route } from './store.js';
import { requestRender } from './ui.js';

type Hook = (route: Route) => void;
const hooks: Hook[] = [];

export function onNavigate(hook: Hook): void {
  hooks.push(hook);
}

export function navigate(route: Route): void {
  if (!ROUTES.includes(route)) return;
  store.menuOpen = false;
  if (store.route !== route) {
    store.route = route;
    if (location.hash !== `#${route}`) history.replaceState(null, '', `#${route}`);
    for (const hook of hooks) hook(route);
  }
  requestRender();
}

export function routeFromHash(): Route {
  const h = location.hash.replace(/^#/, '');
  return (ROUTES as readonly string[]).includes(h) ? (h as Route) : 'overview';
}
