// Inventory the English prose left in server source after UI copy moved to
// i18n codes, so reviewers can check nothing user-facing slipped through.
// Usage: bun run scripts/audit-i18n-server.ts [output.json]  (stdout by default)
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import ts from "typescript"
import { describeServerUiText } from "../src/shared/ui-copy"

const output = process.argv[2]
const records: { file: string; line: number; category: string; text: string }[] = []
for (const relative of await readdir("src/server", { recursive: true })) {
  if (!relative.endsWith(".ts") || /\.test\.ts$/.test(relative)) continue
  const file = join("src/server", relative)
  const source = await readFile(file, "utf8")
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  function visit(node: ts.Node) {
    let value: string | undefined
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) value = node.text
    else if (ts.isTemplateExpression(node)) value = node.head.text + node.templateSpans.map((span, index) => `{{v${index}}}${span.literal.text}`).join("")
    if (value && /[a-zA-Z]{3}/.test(value) && (/[a-zA-Z][ .!?:…\n]+[a-zA-Z]/.test(value) || /^[A-Z][a-z]+$/.test(value))) {
      let category = "protocol_or_product_name"
      let owner: ts.Node | undefined = node
      let prompt = false, error = false, logged = false
      while (owner) {
        if (ts.isNewExpression(owner) && /Error$/.test(owner.expression.getText(ast))) error = true
        if (ts.isCallExpression(owner) && /console\.|logger\.|log$/.test(owner.expression.getText(ast))) logged = true
        if (ts.isVariableDeclaration(owner) && /PROMPT|SCHEMA|EXAMPLE|INSTRUCTION|SYSTEM|PLAN_RESPONSE|MEMORY_.*MESSAGE/i.test(owner.name.getText(ast))) prompt = true
        owner = owner.parent
      }
      const sample = value.replace(/{{v\d+}}/g, "example")
      if (describeServerUiText(sample)) { ts.forEachChild(node, visit); return }
      if (prompt || /prompts?\.ts$|branch-stages\.ts$|schema/.test(file)) category = "model_prompt_or_schema"
      else if (/MemoryFile\.ts$|standalone-export/.test(file)) category = "canonical_export_or_file_content"
      else if (logged) category = "log_or_diagnostic"
      else if (error) category = "raw_exception"
      else if (/agent|codex|pi-|provider|claude|diff-store|terminal|tunnel|cli|auth|keybindings|update/.test(file)) category = "runtime_provider_or_diagnostic"
      else category = "server_internal_or_protocol"
      records.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, category, text: value })
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
}
const report = JSON.stringify({
  scope: "All English prose-like string literals and templates in production src/server TypeScript, excluding translated UI catalog matches; includes non-UI prompts and diagnostics for an explicit retention audit.",
  categories: Object.fromEntries([...new Set(records.map((record) => record.category))].map((category) => [category, records.filter((record) => record.category === category).length])),
  records,
}, null, 2) + "\n"
if (output) {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, report)
  console.error(JSON.stringify({ output, records: records.length }))
} else {
  process.stdout.write(report)
}
