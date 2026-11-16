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
}

export default nextConfig
