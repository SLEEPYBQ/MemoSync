// Adapted from Magpie (https://github.com/yetone/magpie), MIT License, Copyright (c) 2026 yetone
// internal/gateway/call_args_stream_test.go: TestCustomInputStreams fixtures.
import { expect, test } from "bun:test"
import { CustomInputStream, customInput } from "./custom-tool"

const patch = '*** Begin Patch\n+"q" \\ é 😀 <a>&\t\n*** End Patch\n'
const fixtures = [
  [JSON.stringify({ input: patch }), patch],
  [String.raw`{"input":"\ud83d\ude00 \u00e9\u0041\/\n"}`, "😀 éA/\n"],
  [String.raw`{"path":"a.go","input":"x\"y"}`, 'x"y'],
  ['{"meta":{"input":"no","list":["input"]},"input":"yes"}', "yes"],
  ['{ "input" : "spaced" }', "spaced"],
  ['"a lone string"', "a lone string"],
  ['{"input":5}', ""], ['{"other":"x"}', ""], ['not json', ""],
]
test("Magpie custom input deltas survive every escape and Unicode split", () => {
  for (const [args, want] of fixtures) for (const size of [1, 2, 3, 5, 7, args.length]) {
    const stream = new CustomInputStream()
    let got = ""
    for (let i = 0; i < args.length; i += size) got += stream.feed(args.slice(i, i + size))
    expect(got).toBe(want)
    if (want) expect(customInput(args)).toBe(want)
  }
})
