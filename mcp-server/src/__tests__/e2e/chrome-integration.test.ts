/**
 * E2E tests for the Curupira MCP server over an in-memory MCP transport.
 * The live-Chrome suite runs only when a CDP endpoint answers on 127.0.0.1:9222.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { connectInMemory, createAppContainer, parseToolText, probeCDP, type ConnectedServer } from '../helpers/mcp-harness.js'

const CDP_HOST = '127.0.0.1'
const CDP_PORT = 9222
const chromeReachable = await probeCDP(CDP_HOST, CDP_PORT)

describe('Curupira server over MCP (no Chrome)', () => {
  let harness: ConnectedServer

  beforeAll(async () => {
    harness = await connectInMemory(createAppContainer({ mockChrome: true }), 'e2e-test-client')
  })

  afterAll(async () => {
    await harness?.close()
  })

  it('should report the server identity on initialize', () => {
    expect(harness.client.getServerVersion()).toEqual({ name: 'curupira-debug', version: '1.1.3' })
  })

  it('should list the statically registered tools', async () => {
    const { tools } = await harness.client.listTools()
    const names = tools.map(t => t.name)

    expect(names).toEqual(expect.arrayContaining([
      'chrome_connect',
      'chrome_status',
      'cdp_evaluate',
      'cdp_navigate',
      'react_detect_version',
      'dom_query_selector'
    ]))
    expect(new Set(names).size).toBe(names.length)
    tools.forEach(tool => expect(tool.inputSchema.type).toBe('object'))
  })

  it('should list prompts', async () => {
    const { prompts } = await harness.client.listPrompts()
    expect(Array.isArray(prompts)).toBe(true)
  })

  it('should reject a tool call while Chrome is not connected', async () => {
    await expect(
      harness.client.callTool({ name: 'cdp_evaluate', arguments: { expression: '1 + 1' } })
    ).rejects.toThrow(/Not connected to Chrome/)
  })

  it('should reject an unknown tool', async () => {
    await expect(
      harness.client.callTool({ name: 'no_such_tool', arguments: {} })
    ).rejects.toThrow()
  })
})

describe.skipIf(!chromeReachable)('Curupira server against live Chrome', () => {
  let harness: ConnectedServer

  beforeAll(async () => {
    harness = await connectInMemory(createAppContainer(), 'e2e-live-client')
    const response = await harness.client.callTool({
      name: 'chrome_connect',
      arguments: { host: CDP_HOST, port: CDP_PORT }
    })
    expect(parseToolText(response).connectionInfo).toMatchObject({ host: CDP_HOST, port: CDP_PORT })
  }, 30000)

  afterAll(async () => {
    if (!harness) return
    await harness.client.callTool({ name: 'chrome_disconnect', arguments: {} }).catch(() => undefined)
    await harness.close()
  })

  it('should evaluate JavaScript in the page', async () => {
    const response = await harness.client.callTool({
      name: 'cdp_evaluate',
      arguments: { expression: '6 * 7' }
    })
    const data = parseToolText(response)

    expect(data.result).toBe(42)
    expect(data.type).toBe('number')
  })

  it('should report a connected status', async () => {
    const response = await harness.client.callTool({ name: 'chrome_status', arguments: {} })
    expect(response.content).toHaveLength(1)
  })
})
