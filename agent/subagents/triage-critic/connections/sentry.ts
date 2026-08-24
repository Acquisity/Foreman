// biome-ignore lint/performance/noBarrelFile: Eve discovers child capabilities by path, so the root's consent-scoped read-only Sentry definition must be mounted here.
export { default } from "../../../connections/sentry.js";
