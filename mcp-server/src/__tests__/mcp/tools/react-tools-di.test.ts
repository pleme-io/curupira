/**
 * Tests for React Tool Provider with Dependency Injection
 * Level 2: MCP Core tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ReactToolProviderFactory } from '../../../mcp/tools/providers/react-tools.factory.js';
import { createTestContainer, resetTestContainer } from '../../test-container.js';
import type { Container } from '../../../core/di/container.js';
import type { MockChromeService } from '../../mocks/chrome-service.mock.js';
import type { MockLogger } from '../../mocks/logger.mock.js';
import type { MockValidator } from '../../mocks/validator.mock.js';
import { ChromeServiceToken, LoggerToken, ValidatorToken } from '../../../core/di/tokens.js';

describe('ReactToolProvider with DI', () => {
  let container: Container;
  let chromeService: MockChromeService;
  let logger: MockLogger;
  let validator: MockValidator;
  let factory: ReactToolProviderFactory;
  let provider: any;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = createTestContainer();
    chromeService = container.resolve(ChromeServiceToken) as MockChromeService;
    logger = container.resolve(LoggerToken) as MockLogger;
    validator = container.resolve(ValidatorToken) as MockValidator;
    
    factory = new ReactToolProviderFactory();
    provider = factory.create({
      chromeService,
      logger,
      validator
    });

    chromeService.simulateConnection();
    send = chromeService.getMockClient().getSendMock();
  });

  afterEach(() => {
    resetTestContainer(container);
  });

  const evaluated = (value: unknown) => ({ result: { type: 'object', value } });

  const respondByScript = (routes: Array<[string, unknown]>) => {
    send.mockImplementation(async (method: string, params: any) => {
      if (method !== 'Runtime.evaluate') return {};
      const hit = routes.find(([needle]) => params.expression.includes(needle));
      return evaluated(hit ? hit[1] : { detected: false });
    });
  };

  describe('listTools', () => {
    it('should return all React tools', () => {
      const tools = provider.listTools();

      expect(tools).toHaveLength(8);

      const toolNames = tools.map((t: any) => t.name);
      expect(toolNames).toEqual(expect.arrayContaining([
        'react_detect_version',
        'react_get_component_tree',
        'react_find_component',
        'react_inspect_component',
        'react_analyze_rerenders',
        'react_capture_state_snapshot',
        'react_inspect_hooks',
        'react_profiler'
      ]));
    });

    it('should have proper tool metadata', () => {
      const tools = provider.listTools();

      tools.forEach((tool: any) => {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool.inputSchema).toHaveProperty('type', 'object');
      });
    });
  });

  describe('react_detect_version tool', () => {
    it('should detect React presence', async () => {
      respondByScript([
        ['__REACT_DEVTOOLS_GLOBAL_HOOK__\n        if (!hook)', {
          detected: true,
          version: '18.2.0',
          hasDevTools: true,
          renderers: [{ version: '18.2.0' }]
        }],
        ['totalComponents: 0', {
          totalComponents: 12,
          functionComponents: 10,
          classComponents: 2,
          memoComponents: 1,
          depth: 5
        }]
      ]);

      const handler = provider.getHandler('react_detect_version');
      expect(handler).toBeDefined();

      const result = await handler.execute({});

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        hasReact: true,
        hasDevTools: true,
        version: '18.2.0',
        hasFiber: true,
        rendererVersion: '18.2.0',
        componentStats: { totalComponents: 12, functionComponents: 10, classComponents: 2, depth: 5 }
      });
      expect(result.data.recommendations).toContain('📊 Found 12 components (10 function, 2 class)');
    });

    it('should handle when React is not detected', async () => {
      respondByScript([]);

      const handler = provider.getHandler('react_detect_version');
      const result = await handler.execute({});

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        hasReact: false,
        hasDevTools: false,
        version: null,
        componentStats: null
      });
      expect(result.data.recommendations).toContain('❌ React not detected - this may not be a React application');
    });
  });

  describe('react_get_component_tree tool', () => {
    it('should get component tree with default arguments', async () => {
      const mockTree = {
        rootSelector: '#root',
        tree: { name: 'App', children: [{ name: 'Header', children: [] }] },
        summary: { totalComponents: 2, maxDepthReached: 10, hasReactDevTools: true },
        aiGuidance: []
      };
      send.mockResolvedValueOnce(evaluated(mockTree));

      const handler = provider.getHandler('react_get_component_tree');
      const result = await handler.execute({});

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject(mockTree);
      expect(result.data.nextSteps).toHaveLength(3);
      const [method, params] = send.mock.calls[0];
      expect(method).toBe('Runtime.evaluate');
      expect(params.expression).toContain("document.querySelector('#root')");
      expect(params.expression).toContain('maxDepthReached: 10');
    });

    it('should respect custom root selector and depth', async () => {
      send.mockResolvedValueOnce(evaluated({ summary: { totalComponents: 0, hasReactDevTools: false } }));

      const handler = provider.getHandler('react_get_component_tree');
      await handler.execute({ rootSelector: '#app', maxDepth: 5 });

      const params = send.mock.calls[0][1];
      expect(params.expression).toContain("document.querySelector('#app')");
      expect(params.expression).toContain('maxDepthReached: 5');
    });

    it('should report an in-page error as failure', async () => {
      send.mockResolvedValueOnce(evaluated({ error: 'Root element not found.', recommendations: ['x'] }));

      const handler = provider.getHandler('react_get_component_tree');
      const result = await handler.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Root element not found.');
      expect(result.data).toEqual({ recommendations: ['x'] });
    });
  });

  describe('react_find_component tool', () => {
    it('should find components by name', async () => {
      const mockResults = {
        query: 'Button',
        found: 2,
        components: [
          { name: 'Button', path: 'App > Layout > Button', props: ['onClick', 'disabled'], state: 'No state' },
          { name: 'SubmitButton', path: 'App > Form > SubmitButton', props: ['onClick', 'loading'], state: 'Has state' }
        ],
        searchMethod: 'DevTools Hook',
        suggestions: []
      };
      send.mockResolvedValueOnce(evaluated(mockResults));

      const handler = provider.getHandler('react_find_component');
      const result = await handler.execute({ componentName: 'Button' });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject(mockResults);
      expect(result.data.nextSteps[0]).toContain('react_inspect_component');
      const params = send.mock.calls[0][1];
      expect(params.expression).toContain("const componentName = 'Button'");
      expect(params.expression).toContain('const maxResults = 10');
    });

    it('should validate componentName parameter is required', async () => {
      const handler = provider.getHandler('react_find_component');
      const result = await handler.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Validation failed for react.react_find_component');
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('react_profiler tool', () => {
    it('should enable profiler', async () => {
      send.mockResolvedValueOnce(evaluated({ message: 'React profiler enabled successfully', duration: 10000 }));

      const handler = provider.getHandler('react_profiler');
      const result = await handler.execute({ enabled: true });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ message: 'React profiler enabled successfully', duration: 10000 });
      expect(send.mock.calls[0][1].expression).toContain('if (true)');
    });

    it('should disable profiler and return data', async () => {
      send.mockResolvedValueOnce(evaluated({ message: 'React profiler disabled', hasData: true }));

      const handler = provider.getHandler('react_profiler');
      const result = await handler.execute({ enabled: false });

      expect(result.success).toBe(true);
      expect(result.data.message).toBe('React profiler disabled');
      expect(result.data.hasData).toBe(true);
      expect(send.mock.calls[0][1].expression).toContain('if (false)');
    });
  });

  describe('error handling', () => {
    it('should handle Chrome not connected', async () => {
      chromeService.simulateDisconnection();

      const handler = provider.getHandler('react_get_component_tree');
      const result = await handler.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Not connected to Chrome');
      expect(send).not.toHaveBeenCalled();
    });

    it('should handle script execution errors', async () => {
      send.mockRejectedValueOnce(new Error('Script execution failed'));

      const handler = provider.getHandler('react_get_component_tree');
      const result = await handler.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('CDP command Runtime.evaluate failed: Script execution failed');
    });

    it('should surface in-page exceptions', async () => {
      send.mockResolvedValueOnce({ result: { type: 'undefined' }, exceptionDetails: { text: 'Uncaught ReferenceError' } });

      const handler = provider.getHandler('react_profiler');
      const result = await handler.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Script execution error: Uncaught ReferenceError');
    });
  });
});
