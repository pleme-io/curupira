import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Container } from '../../core/di/container.js'
import { ChromeConfigToken, ChromeServiceToken, LoggerToken } from '../../core/di/tokens.js'
import {
  createApplicationContainer,
  registerResourceProviders,
  registerToolProviders
} from '../../infrastructure/container/app.container.js'
import { CurupiraServer } from '../../server/server.js'
import { MockChromeService } from '../mocks/chrome-service.mock.js'

export interface ConnectedServer {
  server: CurupiraServer
  client: Client
  close: () => Promise<void>
}

export function createAppContainer(options: { mockChrome?: boolean } = {}): Container {
  const container = createApplicationContainer()
  if (options.mockChrome) {
    container.register(ChromeServiceToken, (c) =>
      new MockChromeService(c.resolve(ChromeConfigToken), c.resolve(LoggerToken)) as any
    )
  }
  registerToolProviders(container)
  registerResourceProviders(container)
  return container
}

export async function connectInMemory(container: Container, clientName = 'test-client'): Promise<ConnectedServer> {
  const server = new CurupiraServer(container)
  ;(server as unknown as { setupRequestHandlers(): void }).setupRequestHandlers()

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.getServer().connect(serverTransport)

  const client = new Client({ name: clientName, version: '1.0.0' })
  await client.connect(clientTransport)

  return {
    server,
    client,
    close: async () => {
      await client.close()
      await server.getServer().close()
    }
  }
}

export function parseToolText(response: { content: unknown }): any {
  const [first] = response.content as Array<{ type: string; text: string }>
  return JSON.parse(first.text)
}

export async function probeCDP(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    return response.ok
  } catch {
    return false
  }
}
