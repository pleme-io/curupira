/**
 * Performance benchmarks for Curupira MCP Server
 * Measures response times, memory usage, and throughput
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { performance } from 'perf_hooks'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ChromeServiceToken } from '../../core/di/tokens.js'
import type { MockChromeService } from '../mocks/chrome-service.mock.js'
import type { MockChromeClient } from '../mocks/chrome-client.mock.js'
import { connectInMemory, createAppContainer, parseToolText, type ConnectedServer } from '../helpers/mcp-harness.js'

interface BenchmarkResult {
  operation: string
  averageTime: number
  minTime: number
  maxTime: number
  throughput: number
  memoryUsed: number
}

const evaluated = (value: unknown) => ({ result: { type: 'object', value } })

describe('Performance Benchmarks', () => {
  let harness: ConnectedServer
  let client: Client
  let chromeService: MockChromeService
  let chromeClient: MockChromeClient
  const results: BenchmarkResult[] = []

  beforeAll(async () => {
    const container = createAppContainer({ mockChrome: true })
    chromeService = container.resolve(ChromeServiceToken) as unknown as MockChromeService
    chromeService.simulateConnection()
    chromeClient = chromeService.getMockClient()
    harness = await connectInMemory(container, 'benchmark-client')
    client = harness.client
  })

  afterAll(async () => {
    await harness?.close()

    console.log('\n=== Curupira Performance Benchmark Results ===\n')
    console.table(results.map(r => ({
      Operation: r.operation,
      'Avg Time (ms)': r.averageTime.toFixed(2),
      'Min Time (ms)': r.minTime.toFixed(2),
      'Max Time (ms)': r.maxTime.toFixed(2),
      'Throughput (ops/sec)': r.throughput.toFixed(0),
      'Memory (MB)': (r.memoryUsed / 1024 / 1024).toFixed(2),
    })))
  })

  beforeEach(() => {
    chromeClient.getSendMock().mockClear()
  })

  const respondWith = (value: unknown) => {
    chromeClient.getSendMock().mockImplementation(async (method: string) =>
      method === 'Runtime.evaluate' ? evaluated(value) : { frameId: 'frame-1', loaderId: 'loader-1' }
    )
  }

  async function benchmark(
    name: string,
    operation: () => Promise<any>,
    iterations: number = 100
  ): Promise<void> {
    const times: number[] = []
    const memStart = process.memoryUsage().heapUsed

    // Warm up
    for (let i = 0; i < 10; i++) {
      await operation()
    }

    // Actual benchmark
    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      await operation()
      const end = performance.now()
      times.push(end - start)
    }

    const memEnd = process.memoryUsage().heapUsed
    const memoryUsed = memEnd - memStart

    const averageTime = times.reduce((a, b) => a + b, 0) / times.length
    const minTime = Math.min(...times)
    const maxTime = Math.max(...times)
    const throughput = 1000 / averageTime // operations per second

    results.push({
      operation: name,
      averageTime,
      minTime,
      maxTime,
      throughput,
      memoryUsed,
    })

    // Basic assertions to ensure reasonable performance
    expect(averageTime).toBeLessThan(100) // Should complete in less than 100ms
    expect(throughput).toBeGreaterThan(10) // At least 10 ops/sec
  }

  describe('Resource Operations', () => {
    it('should benchmark resources/list', async () => {
      const { resources } = await client.listResources()
      expect(resources.map(r => r.uri)).toEqual(expect.arrayContaining(['browser://status', 'dom://current']))

      await benchmark('resources/list', () => client.listResources())
    })
  })

  describe('Tool Operations', () => {
    it('should benchmark tools/list', async () => {
      const { tools } = await client.listTools()
      expect(tools.length).toBeGreaterThan(100)

      await benchmark('tools/list', () => client.listTools())
    })

    it('should benchmark cdp_evaluate', async () => {
      respondWith('Example Domain')

      const data = parseToolText(await client.callTool({ name: 'cdp_evaluate', arguments: { expression: 'document.title' } }))
      expect(data.result).toBe('Example Domain')

      await benchmark('cdp_evaluate', () =>
        client.callTool({ name: 'cdp_evaluate', arguments: { expression: 'document.title' } })
      )
    })

    it('should benchmark dom_query_selector', async () => {
      respondWith([{ tagName: 'H1', textContent: 'Example Domain' }])

      const data = parseToolText(await client.callTool({ name: 'dom_query_selector', arguments: { selector: 'h1' } }))
      expect(data.count).toBe(1)

      await benchmark('dom_query_selector', () =>
        client.callTool({ name: 'dom_query_selector', arguments: { selector: 'h1' } })
      )
    })

    it('should benchmark react_find_component', async () => {
      respondWith({
        query: 'TestComponent',
        found: 1,
        components: [{ name: 'TestComponent', path: 'App > TestComponent', props: [] }],
        searchMethod: 'DevTools Hook',
        suggestions: []
      })

      const data = parseToolText(await client.callTool({ name: 'react_find_component', arguments: { componentName: 'TestComponent' } }))
      expect(data.found).toBe(1)

      await benchmark('react_find_component', () =>
        client.callTool({ name: 'react_find_component', arguments: { componentName: 'TestComponent' } })
      )
    })
  })

  describe('Complex Operations', () => {
    it('should benchmark tool execution sequence', async () => {
      respondWith('ok')

      await benchmark('navigate + evaluate + query', async () => {
        await client.callTool({ name: 'cdp_navigate', arguments: { url: 'https://example.com' } })
        await client.callTool({ name: 'cdp_evaluate', arguments: { expression: 'document.title' } })
        await client.callTool({ name: 'dom_query_selector', arguments: { selector: 'h1' } })
      }, 50)

      expect(chromeClient.getSendMock()).toHaveBeenCalledWith('Page.navigate', { url: 'https://example.com' }, expect.any(String))
    })
  })

  describe('Memory and Throughput Tests', () => {
    it('should handle high-frequency concurrent requests', async () => {
      respondWith(42)

      const start = performance.now()
      const responses = await Promise.all(
        Array.from({ length: 1000 }, () =>
          client.callTool({ name: 'cdp_evaluate', arguments: { expression: '6 * 7' } })
        )
      )
      const elapsed = performance.now() - start

      console.log(`1000 concurrent cdp_evaluate calls: ${elapsed.toFixed(2)}ms`)
      expect(responses.every(r => parseToolText(r).result === 42)).toBe(true)
      expect(elapsed).toBeLessThan(5000)
    })

    it('should not leak memory over extended operations', async () => {
      respondWith(Array.from({ length: 100 }, (_, i) => ({ id: i, value: 'x'.repeat(1000) })))

      const memStart = process.memoryUsage().heapUsed
      for (let i = 0; i < 100; i++) {
        await client.callTool({ name: 'cdp_evaluate', arguments: { expression: 'bigPayload' } })
        if (global.gc) {
          global.gc()
        }
      }
      const memoryGrowth = (process.memoryUsage().heapUsed - memStart) / 1024 / 1024

      console.log(`Memory growth over 100 operations: ${memoryGrowth.toFixed(2)} MB`)
      expect(memoryGrowth).toBeLessThan(50)
    })
  })

  describe('Large Data Handling', () => {
    it('should handle large evaluation results', async () => {
      const largeMessages = Array.from({ length: 1000 }, () => ({ type: 'log', text: 'x'.repeat(100) }))
      respondWith(largeMessages)

      const start = performance.now()
      const data = parseToolText(await client.callTool({ name: 'cdp_evaluate', arguments: { expression: 'messages' } }))
      const responseTime = performance.now() - start

      console.log(`Large data handling (1000 messages): ${responseTime.toFixed(2)}ms`)
      expect(data.result).toHaveLength(1000)
      expect(responseTime).toBeLessThan(500)
    })
  })
})
