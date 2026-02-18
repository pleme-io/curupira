/**
 * Staging Login Tool Provider Factory - Level 2 (MCP Core)
 * Automated login for NovaSkyn staging environment
 *
 * Usage:
 *   1. chrome_launch() - Launch Chrome with debugging
 *   2. chrome_connect(host: "localhost", port: 9222) - Connect to Chrome
 *   3. staging_login(email: "...", password: "...") - Login to staging
 */

import type { IToolProviderFactory, ProviderDependencies } from '../provider.factory.js';
import { BaseProviderFactory } from '../provider.factory.js';
import type { BaseToolProviderConfig } from '../base-tool-provider.js';
import { BaseToolProvider } from '../base-tool-provider.js';
import type { Schema } from '../../../core/interfaces/validator.interface.js';
import { withCDPCommand, withScriptExecution } from '../patterns/common-handlers.js';

// Schema definitions
const stagingLoginSchema: Schema<{
  email: string;
  password: string;
  url?: string;
}> = {
  parse: (value) => {
    if (typeof value !== 'object' || value === null) {
      throw new Error('Expected object');
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj.email !== 'string' || !obj.email) {
      throw new Error('email must be a non-empty string');
    }
    if (typeof obj.password !== 'string' || !obj.password) {
      throw new Error('password must be a non-empty string');
    }
    return {
      email: obj.email,
      password: obj.password,
      url: typeof obj.url === 'string' ? obj.url : 'https://staging.novaskyn.com/login',
    };
  },
  safeParse: (value) => {
    try {
      return { success: true, data: stagingLoginSchema.parse(value) };
    } catch (error) {
      return { success: false, error };
    }
  },
};

class StagingLoginToolProvider extends BaseToolProvider {
  protected initializeTools(): void {
    // Register staging_login tool
    this.registerTool(
      this.createTool(
        'staging_login',
        'Login to NovaSkyn staging environment (requires connected Chrome via chrome_connect)',
        stagingLoginSchema,
        async (args, context) => {
          context.logger.info({ url: args.url }, 'Performing staging login');

          // Navigate to login page
          context.logger.info(`Navigating to ${args.url}`);
          const navigateResult = await withCDPCommand(
            'Page.navigate',
            { url: args.url },
            context
          );

          if (navigateResult.isErr()) {
            return {
              success: false,
              error: `Failed to navigate: ${navigateResult.unwrapErr()}`,
              data: {
                troubleshooting: [
                  'Make sure Chrome is connected via chrome_connect',
                  'Check if staging.novaskyn.com is accessible',
                ],
              },
            };
          }

          // Wait for page to load
          context.logger.info('Waiting for page to load...');
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Wait for email field
          context.logger.info('Waiting for login form...');
          const waitResult = await this.waitForSelector(
            '[data-testid="email-input"]',
            context,
            10000
          );

          if (!waitResult) {
            return {
              success: false,
              error: 'Login form not found - page may not have loaded correctly',
              data: {
                troubleshooting: [
                  'Check if staging.novaskyn.com is accessible',
                  'The page may be loading slowly - try again',
                  'Check browser console for errors',
                ],
              },
            };
          }

          // Enter email
          context.logger.info('Entering email...');
          await this.setInputValue('[data-testid="email-input"]', args.email, context);
          await new Promise((resolve) => setTimeout(resolve, 300));

          // Enter password
          context.logger.info('Entering password...');
          await this.setInputValue('[data-testid="password-input"]', args.password, context);
          await new Promise((resolve) => setTimeout(resolve, 300));

          // Click submit
          context.logger.info('Submitting login form...');
          await this.clickElement('[data-testid="login-submit-button"]', context);

          // Wait for navigation
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Check current URL
          const urlResult = await withScriptExecution<string>(
            'window.location.href',
            context,
            { returnByValue: true, awaitPromise: false }
          );

          if (urlResult.isErr()) {
            return {
              success: false,
              error: `Failed to get current URL: ${urlResult.unwrapErr()}`,
            };
          }

          const currentUrl = urlResult.unwrap();
          const isStillOnLogin = currentUrl.includes('/login');

          if (isStillOnLogin) {
            // Check for error message
            const errorResult = await withScriptExecution<string | null>(
              `(() => {
                const alert = document.querySelector('[role="alert"]');
                return alert ? alert.textContent : null;
              })()`,
              context,
              { returnByValue: true, awaitPromise: false }
            );

            const errorMessage = errorResult.isOk() ? errorResult.unwrap() : null;

            return {
              success: false,
              error: errorMessage || 'Login failed - still on login page',
              data: {
                currentUrl,
                troubleshooting: [
                  'Verify credentials are correct',
                  'Check if email is verified',
                  'Check browser for error messages',
                ],
              },
            };
          }

          context.logger.info('Login successful!');

          return {
            success: true,
            data: {
              message: 'Successfully logged into staging!',
              currentUrl,
              email: args.email,
              nextSteps: [
                'Use react_get_component_tree to inspect React components',
                'Use dom_query_selector to find elements',
                'Use zustand_store_inspect to check state',
                'Use apollo_cache_inspect to view GraphQL cache',
              ],
            },
          };
        },
        {
          type: 'object',
          properties: {
            email: {
              type: 'string',
              description: 'Email address for staging login',
            },
            password: {
              type: 'string',
              description: 'Password for staging login',
            },
            url: {
              type: 'string',
              description: 'Login URL (default: https://staging.novaskyn.com/login)',
            },
          },
          required: ['email', 'password'],
        }
      )
    );
  }

  // Helper methods for DOM manipulation using withScriptExecution
  private async waitForSelector(
    selector: string,
    context: any,
    timeout: number = 10000
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const result = await withScriptExecution<boolean>(
        `document.querySelector('${selector}') !== null`,
        context,
        { returnByValue: true, awaitPromise: false }
      );

      if (result.isOk() && result.unwrap() === true) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return false;
  }

  private async setInputValue(selector: string, value: string, context: any): Promise<void> {
    const script = `
      (() => {
        const element = document.querySelector('${selector}');
        if (!element) throw new Error('Element not found: ${selector}');

        // Focus the element
        element.focus();

        // Set the value using native input setter to trigger React's onChange
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(element, ${JSON.stringify(value)});

        // Dispatch input and change events for React
        const inputEvent = new Event('input', { bubbles: true });
        const changeEvent = new Event('change', { bubbles: true });
        element.dispatchEvent(inputEvent);
        element.dispatchEvent(changeEvent);

        return true;
      })()
    `;

    await withScriptExecution(script, context, { returnByValue: true, awaitPromise: false });
  }

  private async clickElement(selector: string, context: any): Promise<void> {
    const script = `
      (() => {
        const element = document.querySelector('${selector}');
        if (!element) throw new Error('Element not found: ${selector}');
        element.click();
        return true;
      })()
    `;

    await withScriptExecution(script, context, { returnByValue: true, awaitPromise: false });
  }
}

export class StagingLoginToolProviderFactory extends BaseProviderFactory<StagingLoginToolProvider> {
  create(deps: ProviderDependencies): StagingLoginToolProvider {
    const config: BaseToolProviderConfig = {
      name: 'staging-login',
      description: 'NovaSkyn staging login automation',
    };

    return new StagingLoginToolProvider(
      deps.chromeService,
      this.createProviderLogger(deps, config.name),
      deps.validator,
      config
    );
  }
}
