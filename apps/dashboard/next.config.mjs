/** @type {import('next').NextConfig} */
const nextConfig = {
  // @sentinel/shared ships ESM dist; transpile it so the browser bundle (canonicalize +
  // blakejs for client-side receipt verify, the shared Receipt/Decision types) resolves
  // cleanly. This is the same proof-contract code the orchestrator uses — verify is real.
  transpilePackages: ['@sentinel/shared'],
  reactStrictMode: true,
  typescript: {
    // Types are checked by `pnpm --filter @sentinel/dashboard typecheck` in CI; don't
    // double-run during `next build`.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
