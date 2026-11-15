import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  base: { service: 'workflow' },
  transport: {
    targets: [
      // 开发环境：终端彩色输出，方便本地排查
      ...(isDev
        ? [
            {
              target: 'pino-pretty',
              level: 'debug',
              options: {
                colorize: true,
                translateTime: 'HH:mm:ss',
                ignore: 'pid,hostname,service',
              },
            },
          ]
        : []),
      // 文件输出：写入 apps/workflow/logs/app.log（JSON 行格式），目录不存在时自动创建
      {
        target: 'pino/file',
        level: isDev ? 'debug' : 'info',
        options: { destination: './logs/app.log', mkdir: true },
      },
    ],
  },
})

/** 为单次请求创建带 requestId 的子 logger，便于串联同一次调用的日志 */
export function createRequestLogger(requestId: string) {
  return logger.child({ requestId })
}
