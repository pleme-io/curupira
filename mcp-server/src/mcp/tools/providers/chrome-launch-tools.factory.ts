/**
 * Chrome Launch Tool Provider Factory - Level 2 (MCP Core)
 * Tools for launching and managing Chrome instances for debugging
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import type { IToolProviderFactory, ProviderDependencies } from '../provider.factory.js';
import { BaseProviderFactory } from '../provider.factory.js';
import type { BaseToolProviderConfig } from '../base-tool-provider.js';
import { ChromeIndependentToolProvider } from '../chrome-independent-tool-provider.js';
import type { Schema } from '../../../core/interfaces/validator.interface.js';

// Track launched Chrome processes
let chromeProcess: ChildProcess | null = null;

// Schema definitions
const launchSchema: Schema<{
  port?: number;
  url?: string;
  headless?: boolean;
  userDataDir?: string;
}> = {
  parse: (value) => {
    const obj = (value || {}) as Record<string, unknown>;
    return {
      port: typeof obj.port === 'number' ? obj.port : 9222,
      url: typeof obj.url === 'string' ? obj.url : undefined,
      headless: typeof obj.headless === 'boolean' ? obj.headless : false,
      userDataDir: typeof obj.userDataDir === 'string' ? obj.userDataDir : undefined,
    };
  },
  safeParse: (value) => {
    try {
      return { success: true, data: launchSchema.parse(value) };
    } catch (error) {
      return { success: false, error };
    }
  },
};

const emptySchema: Schema<Record<string, unknown>> = {
  parse: (value) => (value || {}) as Record<string, unknown>,
  safeParse: (value) => ({ success: true, data: (value || {}) as Record<string, unknown> }),
};

/**
 * Wait for Chrome DevTools Protocol to be available
 */
async function waitForCDP(host: string, port: number, timeout: number = 30000): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(`http://${host}:${port}/json/version`);
      if (response.ok) {
        return true;
      }
    } catch {
      // CDP not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

/**
 * Detect DISPLAY environment variable for X11/Wayland
 * Auto-detects from X11 sockets if not set in environment
 */
function detectDisplay(): string | null {
  // Check if DISPLAY is already set
  if (process.env.DISPLAY) {
    return process.env.DISPLAY;
  }

  // Check for WAYLAND_DISPLAY
  if (process.env.WAYLAND_DISPLAY) {
    // On Wayland with XWayland, we still need DISPLAY for Chrome
    // Try to find X11 socket
  }

  // Auto-detect from X11 sockets
  try {
    const x11SocketDir = '/tmp/.X11-unix';
    if (fs.existsSync(x11SocketDir)) {
      const sockets = fs.readdirSync(x11SocketDir);
      // Look for X0, X1, etc.
      for (const socket of sockets) {
        if (socket.startsWith('X') && !socket.includes('_')) {
          const displayNum = socket.substring(1);
          return `:${displayNum}`;
        }
      }
    }
  } catch {
    // Ignore errors reading socket directory
  }

  return null;
}

/**
 * Find Chrome binary on the system
 */
function findChromeBinary(): string | null {
  const possiblePaths = [
    // Linux (NixOS, typical installs)
    '/run/current-system/sw/bin/google-chrome-stable',
    `${process.env.HOME}/.nix-profile/bin/google-chrome-stable`,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Windows (for completeness)
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  for (const path of possiblePaths) {
    try {
      if (fs.existsSync(path)) {
        return path;
      }
    } catch {
      continue;
    }
  }

  // Try using which command
  try {
    const result = execSync('which google-chrome-stable || which google-chrome || which chromium', {
      encoding: 'utf-8',
    }).trim();
    if (result) {
      return result.split('\n')[0];
    }
  } catch {
    // Ignore errors
  }

  return null;
}

class ChromeLaunchToolProvider extends ChromeIndependentToolProvider {
  protected initializeTools(): void {
    // Register chrome_launch tool
    this.registerTool(
      this.createTool(
        'chrome_launch',
        'Launch a Chrome instance with remote debugging enabled for Curupira MCP',
        launchSchema,
        async (args, context) => {
          context.logger.info({ args }, 'Launching Chrome instance');

          // Check if Chrome is already running with this process
          if (chromeProcess && !chromeProcess.killed) {
            context.logger.info('Chrome already running from previous launch');
            return {
              success: true,
              data: {
                message: 'Chrome already running from previous launch',
                port: args.port,
                alreadyRunning: true,
                nextSteps: [
                  'Use chrome_connect to connect to the running instance',
                  'Use chrome_kill to stop and relaunch if needed',
                ],
              },
            };
          }

          // Find Chrome binary
          const chromeBinary = findChromeBinary();
          if (!chromeBinary) {
            return {
              success: false,
              error: 'Chrome binary not found',
              data: {
                troubleshooting: [
                  'Install Google Chrome or Chromium',
                  'On NixOS: nix-env -iA nixpkgs.google-chrome',
                  'On Ubuntu: sudo apt install google-chrome-stable',
                  'On macOS: Install from https://www.google.com/chrome/',
                ],
              },
            };
          }

          // Build Chrome arguments
          const chromeArgs = [
            `--remote-debugging-port=${args.port}`,
            '--remote-debugging-address=0.0.0.0',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor,IsolateOrigins,site-per-process',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-field-trial-config',
            '--disable-ipc-flooding-protection',
            '--disable-default-apps',
            '--disable-component-extensions-with-background-pages',
            '--disk-cache-size=1',
            '--media-cache-size=1',
            '--disable-application-cache',
            '--no-first-run',
            '--no-default-browser-check',
            `--user-data-dir=${args.userDataDir || `${process.env.HOME}/.chrome-dev`}`,
            '--window-position=100,100',
            '--window-size=1400,900',
            '--new-window',
          ];

          if (args.headless) {
            chromeArgs.push('--headless=new');
          }

          if (args.url) {
            chromeArgs.push(args.url);
          }

          // Detect DISPLAY for X11/Wayland
          const display = detectDisplay();
          if (!display && !args.headless) {
            return {
              success: false,
              error: 'No DISPLAY detected - cannot launch Chrome in GUI mode',
              data: {
                troubleshooting: [
                  'Set DISPLAY environment variable (e.g., DISPLAY=:0)',
                  'Or use headless mode: chrome_launch(headless: true)',
                  'Check if X11 or Wayland is running',
                ],
              },
            };
          }

          context.logger.info({ chromeBinary, chromeArgs, display }, 'Spawning Chrome process');

          try {
            // Kill any existing Chrome dev instances first
            try {
              execSync(`pkill -f "chrome.*remote-debugging-port=${args.port}" || true`, {
                stdio: 'ignore',
              });
              await new Promise((resolve) => setTimeout(resolve, 1000));
            } catch {
              // Ignore kill errors
            }

            // Build environment with DISPLAY
            const spawnEnv: Record<string, string> = {
              ...process.env as Record<string, string>,
              HOME: process.env.HOME || '/tmp',
            };
            if (display) {
              spawnEnv.DISPLAY = display;
            }

            // Spawn Chrome with proper environment
            chromeProcess = spawn(chromeBinary, chromeArgs, {
              detached: true,
              stdio: 'ignore',
              env: spawnEnv,
            });

            chromeProcess.unref();

            // Wait for CDP to be available
            context.logger.info('Waiting for Chrome DevTools Protocol to be ready...');
            const cdpReady = await waitForCDP('localhost', args.port!, 30000);

            if (!cdpReady) {
              return {
                success: false,
                error: 'Chrome started but CDP not available',
                data: {
                  troubleshooting: [
                    'Chrome may still be starting - wait and try chrome_discover',
                    'Check if port is blocked by firewall',
                    'Check Chrome process logs',
                  ],
                },
              };
            }

            context.logger.info('Chrome launched successfully');

            return {
              success: true,
              data: {
                message: 'Chrome launched with remote debugging enabled!',
                chromeBinary,
                port: args.port,
                url: args.url,
                headless: args.headless,
                display: display || 'headless',
                pid: chromeProcess.pid,
                cdpEndpoint: `http://localhost:${args.port}`,
                nextSteps: [
                  `Connect with: chrome_connect(host: "localhost", port: ${args.port})`,
                  'Use staging_login to authenticate to staging',
                  'Then use React debugging tools',
                ],
              },
            };
          } catch (error) {
            context.logger.error({ error }, 'Failed to launch Chrome');
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to launch Chrome',
              data: {
                chromeBinary,
                troubleshooting: [
                  'Check Chrome installation',
                  'Verify user has permission to run Chrome',
                  'Check system logs for errors',
                ],
              },
            };
          }
        },
        {
          type: 'object',
          properties: {
            port: {
              type: 'number',
              description: 'Remote debugging port (default: 9222)',
            },
            url: {
              type: 'string',
              description: 'Initial URL to navigate to',
            },
            headless: {
              type: 'boolean',
              description: 'Run Chrome in headless mode (default: false)',
            },
            userDataDir: {
              type: 'string',
              description: 'Chrome user data directory (default: ~/.chrome-dev)',
            },
          },
          required: [],
        }
      )
    );

    // Register chrome_kill tool
    this.registerTool(
      this.createTool(
        'chrome_kill',
        'Kill the Chrome instance launched by chrome_launch',
        emptySchema,
        async (_args, context) => {
          context.logger.info('Killing Chrome instance');

          if (chromeProcess && !chromeProcess.killed) {
            chromeProcess.kill();
            chromeProcess = null;
            return {
              success: true,
              data: {
                message: 'Chrome instance terminated',
              },
            };
          }

          // Try to kill any chrome-dev instances
          try {
            execSync('pkill -f "chrome.*remote-debugging-port=9222" || true', {
              stdio: 'ignore',
            });
            return {
              success: true,
              data: {
                message: 'Killed Chrome dev instances',
              },
            };
          } catch {
            return {
              success: false,
              error: 'No Chrome instance to kill',
            };
          }
        },
        {
          type: 'object',
          properties: {},
          required: [],
        }
      )
    );
  }
}

export class ChromeLaunchToolProviderFactory extends BaseProviderFactory<ChromeLaunchToolProvider> {
  create(deps: ProviderDependencies): ChromeLaunchToolProvider {
    const config: BaseToolProviderConfig = {
      name: 'chrome-launch',
      description: 'Chrome launch and management tools',
    };

    return new ChromeLaunchToolProvider(
      deps.chromeService,
      this.createProviderLogger(deps, config.name),
      deps.validator,
      config
    );
  }
}
