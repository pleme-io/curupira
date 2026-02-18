import pino, { type Logger as PinoLogger } from 'pino'
import { config } from './index.js'

const isDev = config.env === 'development'

const baseLogger = pino({
  level: config.logLevel,
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname',
          translateTime: 'HH:MM:ss',
        },
      }
    : undefined,
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() }
    },
  },
  serializers: {
    error: pino.stdSerializers.err,
    request: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      ip: req.ip,
    }),
    response: (res) => ({
      statusCode: res.statusCode,
    }),
  },
})

// Wrapper to support flexible calling patterns:
// logger.error('message')
// logger.error('message', data)
// logger.error({data}, 'message')
function createFlexibleMethod(method: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal') {
  return (msgOrObj: string | object, dataOrMsg?: unknown) => {
    if (typeof msgOrObj === 'string') {
      if (dataOrMsg === undefined) {
        baseLogger[method](msgOrObj)
      } else if (typeof dataOrMsg === 'string') {
        baseLogger[method]({ data: msgOrObj }, dataOrMsg)
      } else {
        // logger.error('message', data) -> logger.error({err: data}, 'message')
        const obj = dataOrMsg instanceof Error
          ? { err: dataOrMsg }
          : typeof dataOrMsg === 'object' && dataOrMsg !== null
            ? dataOrMsg
            : { data: dataOrMsg }
        baseLogger[method](obj as object, msgOrObj)
      }
    } else {
      baseLogger[method](msgOrObj, dataOrMsg as string | undefined)
    }
  }
}

export const logger = {
  trace: createFlexibleMethod('trace'),
  debug: createFlexibleMethod('debug'),
  info: createFlexibleMethod('info'),
  warn: createFlexibleMethod('warn'),
  error: createFlexibleMethod('error'),
  fatal: createFlexibleMethod('fatal'),
  child: (bindings: object) => baseLogger.child(bindings),
  level: baseLogger.level,
}