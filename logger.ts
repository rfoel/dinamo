const log =
  (type: 'debug' | 'error' | 'info' | 'warn') =>
  (...contents: any) =>
    console[type](JSON.stringify(contents, null, 2))

const logger = {
  debug: log('debug'),
  error: log('error'),
  info: log('info'),
  warn: log('warn'),
}

export default logger
