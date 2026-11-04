/** Scripted OpenAI-compatible endpoint. No real provider or credential is used. */
export function createOpencodeFakeModel(project: string) {
  const requests: Array<{ authorization: string | null; body: any }> = []
  const chunk = (delta: unknown, finish_reason: string | null = null, usage?: unknown) => `data: ${JSON.stringify({ id: 'fake-completion', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`
  const finish = (reason: string) => chunk({}, reason, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } }) + 'data: [DONE]\n\n'
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const body = await request.json() as any
      requests.push({ authorization: request.headers.get('authorization'), body })
      const messages = body.messages ?? []
      const userIndex = messages.map((m: any) => m.role).lastIndexOf('user')
      const user = JSON.stringify(messages[userIndex]?.content)
      const results = messages.slice(userIndex).filter((m: any) => m.role === 'tool')
      const names = (body.tools ?? []).map((t: any) => t.function.name)
      const text = (value: string) => new Response(chunk({ content: value.slice(0, 4) }) + chunk({ content: value.slice(4) }) + finish('stop'), { headers: { 'content-type': 'text/event-stream' } })
      const call = (id: string, name: string, args: unknown) => new Response(chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + finish('tool_calls'), { headers: { 'content-type': 'text/event-stream' } })
      if (!names.length) return text('Fake title')
      if (user.includes('Your previous output was invalid')) {
        const previousUser = messages.slice(0, userIndex).findLast((m: any) => m.role === 'user')
        if (JSON.stringify(previousUser?.content).includes('INVALID_JSON')) return text('{"codeword":"pelican"}')
        if (JSON.stringify(previousUser?.content).includes('BRANCH_ANALYSIS')) {
          const tool = (id: string) => String(messages.findLast((m: any) => m.role === 'tool' && m.tool_call_id === id)?.content)
          return text(JSON.stringify({ inside: tool('call_branch_inside').includes('hello fixture'), outsideDenied: tool('call_branch_outside').toLowerCase().includes('reject'), bashDenied: tool('call_branch_bash').includes('unavailable tool') }))
        }
        const budgetTool = messages.findLast((m: any) => m.role === 'tool' && m.tool_call_id === 'call_budget_2')
        if (budgetTool) return text(JSON.stringify({ budgetDenied: String(budgetTool.content).toLowerCase().includes('reject') }))
        return text('{"codeword":"pelican"}')
      }
      if (user.includes('MODEL_ERROR')) return Response.json({ error: { message: 'Scripted model failure', type: 'invalid_request_error' } }, { status: 400, headers: { 'x-private-token': 'never-export-this-header' } })
      if (user.includes('CANCEL_STREAM')) {
        let timer: ReturnType<typeof setInterval>
        return new Response(new ReadableStream({
          start(controller) { timer = setInterval(() => { try { controller.enqueue(new TextEncoder().encode(chunk({ content: 'slow word ' }))) } catch { clearInterval(timer) } }, 75) },
          cancel() { clearInterval(timer) },
        }), { headers: { 'content-type': 'text/event-stream' } })
      }
      if (user.includes('BRANCH_BUDGET')) {
        if (!results.length) return call('call_budget_1', 'read', { filePath: `${project}/a.txt` })
        if (results.length === 1) return call('call_budget_2', 'read', { filePath: `${project}/b.txt` })
        return text(JSON.stringify({ budgetDenied: JSON.stringify(results[1]).toLowerCase().includes('reject') }))
      }
      if (user.includes('BRANCH_ANALYSIS')) {
        if (!results.length) return call('call_branch_inside', 'read', { filePath: `${project}/a.txt` })
        if (results.length === 1) return call('call_branch_bash', 'bash', { command: `touch ${project}/should-not-exist`, description: 'forbidden' })
        if (results.length === 2) return call('call_branch_outside', 'read', { filePath: `${project}/../outside.txt` })
        return text(JSON.stringify({ inside: JSON.stringify(results[0]).includes('hello fixture'), outsideDenied: !JSON.stringify(results[2]).includes('private outside'), bashDenied: JSON.stringify(results[1]).includes('unavailable tool') }))
      }
      if (user.includes('TURN_MEMORY')) {
        if (!results.length) return call('call_memory', names.find((n: string) => n.includes('search_memory')) ?? 'invalid', { query: 'codeword' })
        if (results.length === 1) return call('call_read', 'read', { filePath: `${project}/a.txt` })
        return text('Codeword pelican and hello fixture [M-7].')
      }
      if (user.includes('TURN_QUESTION')) {
        if (!results.length) return call('call_question', 'question', { questions: [{ question: 'Pick a color?', header: 'Color', options: [{ label: 'red', description: 'Red' }, { label: 'blue', description: 'Blue' }] }] })
        return text(`Answer received: ${JSON.stringify(results.at(-1).content)}`)
      }
      if (user.includes('INVALID_JSON') && !user.includes('Your previous output was invalid')) return text('not json')
      return text('{"codeword":"pelican"}')
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, close() { server.stop(true) } }
}
