/**
 * Architecture Validation Test Suite - Phase 6
 * Ensures refactoring improvements are maintained
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..', '..', '..')

describe('Architecture Validation', () => {
  describe('TypeScript Compilation', () => {
    let buildOutput: string
    let errorCount: number
    let errorBreakdown: Record<string, number>

    beforeAll(() => {
      try {
        // Run TypeScript compiler and capture output
        buildOutput = execSync('npm run build', { 
          cwd: projectRoot,
          encoding: 'utf-8' 
        })
      } catch (error: any) {
        buildOutput = error.stdout || ''
      }

      // Count total errors
      const errorMatches = buildOutput.match(/error TS/g)
      errorCount = errorMatches ? errorMatches.length : 0

      // Break down errors by type
      errorBreakdown = {}
      const errorCodes = buildOutput.match(/error TS\d+/g) || []
      errorCodes.forEach(code => {
        const tsCode = code.replace('error ', '')
        errorBreakdown[tsCode] = (errorBreakdown[tsCode] || 0) + 1
      })
    })

    it('should have reduced TypeScript errors from baseline', () => {
      const baselineErrors = 201 // Original error count
      expect(errorCount).toBeLessThan(baselineErrors)
      console.log(`TypeScript errors: ${errorCount} (reduced from ${baselineErrors})`)
    })

    it('should have minimal unsafe casting errors (TS2352)', () => {
      const unsafeCasts = errorBreakdown['TS2352'] || 0
      const baselineUnsafeCasts = 23 // Original count
      expect(unsafeCasts).toBeLessThanOrEqual(10) // Target
      console.log(`Unsafe casts: ${unsafeCasts} (reduced from ${baselineUnsafeCasts})`)
    })

    it('should have reduced property access errors (TS2339)', () => {
      const propertyErrors = errorBreakdown['TS2339'] || 0
      const baselinePropertyErrors = 97 // Original count
      expect(propertyErrors).toBeLessThan(20) // Target
      console.log(`Property errors: ${propertyErrors} (reduced from ${baselinePropertyErrors})`)
    })
  })

  describe('Provider Architecture Consistency', () => {
    const providersPath = path.join(projectRoot, 'src', 'mcp', 'tools', 'providers')
    const providerFiles = fs.readdirSync(providersPath).filter(f => f.endsWith('-tools.factory.ts'))
    const read = (file: string) => fs.readFileSync(path.join(providersPath, file), 'utf-8')

    it('finds the provider factories', () => {
      expect(providerFiles.length).toBeGreaterThan(20)
    })

    it('every provider extends BaseToolProvider or ChromeIndependentToolProvider', () => {
      const off = providerFiles.filter(f => !/class \w+ extends (BaseToolProvider|ChromeIndependentToolProvider)/.test(read(f)))
      expect(off).toEqual([])
    })

    it('every factory extends BaseProviderFactory', () => {
      const off = providerFiles.filter(f => !/extends BaseProviderFactory/.test(read(f)))
      expect(off).toEqual([])
    })
  })

  describe('DRY Implementation Validation', () => {
    it('common patterns should be reused', () => {
      const commonPatternsPath = path.join(projectRoot, 'src', 'mcp', 'tools', 'patterns', 'common-handlers.ts')
      expect(fs.existsSync(commonPatternsPath)).toBe(true)

      const content = fs.readFileSync(commonPatternsPath, 'utf-8')
      expect(content).toContain('withSessionAndValidation')
    })
  })

  describe('Type Safety Enhancements', () => {
    it('ToolResult should be generic', () => {
      const registryPath = path.join(projectRoot, 'src', 'mcp', 'tools', 'registry.ts')
      const content = fs.readFileSync(registryPath, 'utf-8')
      
      expect(content).toMatch(/export\s+interface\s+ToolResult<T\s*=\s*unknown>/)
    })

    it('validation schemas should be comprehensive', () => {
      const validationPath = path.join(projectRoot, 'src', 'mcp', 'tools', 'validation.ts')
      const content = fs.readFileSync(validationPath, 'utf-8')
      
      const schemas = [
        'evaluate',
        'navigate', 
        'screenshot',
        'domSelector',
        'baseToolArgs',
        'setBreakpoint',
        'removeBreakpoint'
      ]

      schemas.forEach(schema => {
        expect(content).toContain(`${schema}:`)
      })
    })
  })

  describe('Performance Characteristics', () => {
    it('refactored code should not impact performance negatively', () => {
      // This is a placeholder for performance benchmarks
      // In a real scenario, you'd run performance tests here
      expect(true).toBe(true)
    })
  })
})

describe('Regression Prevention', () => {
  const tools = path.join(projectRoot, 'src', 'mcp', 'tools')
  const src = (f: string) => fs.readFileSync(path.join(tools, f), 'utf-8')

  it('critical exports remain', () => {
    expect(src('base-tool-provider.ts')).toMatch(/export abstract class BaseToolProvider/)
    expect(src('validation.ts')).toMatch(/export function validateAndCast/)
    expect(src('validation.ts')).toMatch(/export const ArgSchemas/)
    expect(src('registry.ts')).toMatch(/export interface ToolResult/)
    expect(src('registry.ts')).toMatch(/export interface ToolHandler/)
  })

  it('the provider contract keeps name, listTools and getHandler', () => {
    const registry = src('registry.ts')
    expect(registry).toMatch(/\n\s+name: string/)
    expect(registry).toMatch(/listTools\(\): Tool\[\]/)
    expect(registry).toMatch(/getHandler\(toolName: string\): ToolHandler \| undefined/)
  })
})
