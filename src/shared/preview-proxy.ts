export const PREVIEW_PROXY_PATH_PREFIX = "/__memosync/preview"

export function previewProxyPath(targetPort: number, pathname = "/") {
  if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
    throw new RangeError(`Invalid preview target port: ${targetPort}`)
  }
  const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`
  return `${PREVIEW_PROXY_PATH_PREFIX}/${targetPort}${suffix}`
}
