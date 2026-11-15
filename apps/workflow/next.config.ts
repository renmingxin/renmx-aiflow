import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /* config options here */
  // cacheComponents: true,
  // 允许在服务端使用 pino 包
  serverExternalPackages: ['pino', 'pino-pretty'],
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_SERVER_URL ?? 'http://localhost:4001'}/:path*`,
      },
    ]
  },
}

export default nextConfig
