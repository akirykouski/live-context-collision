/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Speechmatics browser SDK ships ESM workers; keep it un-transpiled-friendly.
  experimental: {
    esmExternals: true,
  },
};

export default nextConfig;
