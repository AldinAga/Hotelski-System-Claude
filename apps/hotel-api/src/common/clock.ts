// The application clock for authentication (session deadlines, TOTP, login
// throttle) and for the inventory's "today". Provided globally by
// DatabaseModule; tests override it to move time.
export const CLOCK = Symbol('CLOCK');
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
