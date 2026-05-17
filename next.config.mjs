/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Speechmatics browser SDK ships ESM workers; keep it un-transpiled-friendly.
  experimental: {
    esmExternals: true,
  },
};

export default nextConfig;
