#!/usr/bin/env bun
// A subprocess stdout stream can split a listening banner inside its port.
const ending = process.env.FAKE_OC_LOG_ENDING === 'crlf' ? '\r\n' : '\n'
const prefix = 'opencode server listening on http://127.0.0.1:'
if (process.env.FAKE_OC_LOG_SPLIT === 'port') {
  process.stdout.write(`${prefix}12`)
  setTimeout(() => process.stdout.write(`345${ending}`), 100)
} else {
  process.stdout.write(`${prefix}12345${ending}`)
}
setInterval(() => {}, 1000)
