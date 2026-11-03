/**
 * Custom GEO check rules, run after the built-in checks of the editor panel.
 *
 * A rule is your code and runs inside your CMS server, with its trust: it is not sandboxed. The plugin only
 * isolates its failures (a throw, a timeout or an invalid result becomes an `error` result of that rule) so one
 * broken rule never breaks the panel or the public outputs (rules never run on public routes).
 */
import type { CheckResult, CheckStatus, DocumentState, Inspection } from './checks.js'
import type { LlmsDocument, LlmsMappingSources } from './llms.js'

/** Rule ids of the built-in checks. Custom rules can't use them. */
export const BUILTIN_RULE_IDS: readonly string[] = Object.freeze([
  'GEO-TITLE', 'GEO-DESCRIPTION', 'GEO-BODY', 'GEO-HEADINGS', 'GEO-AUTHOR', 'GEO-DATES', 'GEO-IMAGE', 'GEO-FAQ',
  'GEO-CONVERSION', 'GEO-CANONICAL', 'GEO-FIELDS', 'GEO-SOURCES', 'GEO-URL', 'GEO-STATUS', 'GEO-PUBLIC',
])

/** Ids must look like `ACME-NO-LOREM`: capital letters, digits and dashes, 3 to 64 characters. */
const RULE_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/
/** Prefixes reserved for the plugin's own rules. */
const RESERVED_PREFIXES = ['GEO-', 'LD-', 'CFG-', 'ACT-', 'EV-']
const STATUSES: ReadonlySet<CheckStatus> = new Set(['pass', 'warning', 'error', 'notApplicable'])

export interface RuleContext<P = Record<string, unknown>> {
  /** Current values of the document (form values in the editor, unsaved edits included). */
  values: Record<string, any>
  /** The document as the public outputs map it, or null when it has no URL. */
  document: LlmsDocument | null
  /** The Markdown body the public outputs serve. */
  markdown: string
  /** Which field each output value came from. */
  sources: LlmsMappingSources
  state: DocumentState
  /** Collection slug / content type name. */
  collection: string
  /** The rule's `params`, for configurable thresholds. */
  params: P
  /** Aborted when the rule times out; pass it to `fetch` if the rule makes requests. */
  signal: AbortSignal
}

export interface RuleOutcome {
  status: CheckStatus
  message: string
  suggestion?: string
  fieldPath?: string
}

export interface GeoRule<P = Record<string, unknown>> {
  /** Stable id, e.g. `ACME-NO-LOREM`. Must not use a built-in id or the `GEO-` / `LD-` prefixes. */
  id: string
  /** Only run for these collections / content types. Default: all configured ones. */
  collections?: string[]
  params?: P
  /** Return one outcome, `null` for "not applicable" (nothing shown), or a promise of either. */
  check(ctx: RuleContext<P>): RuleOutcome | null | undefined | Promise<RuleOutcome | null | undefined>
}

export interface RuleRunOptions {
  /** Per-rule time limit for async rules. Default 2000 ms. */
  timeoutMs?: number
}

/**
 * Validates rules once, at config time. Throws on an invalid or reserved id, a duplicate id or a missing
 * `check`, so mistakes surface when the CMS starts, not in the editor.
 */
export function defineRules(rules: readonly GeoRule<any>[]): GeoRule<any>[] {
  const seen = new Set<string>()
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') throw new TypeError('[geo] a rule must be an object')
    const id = rule.id
    if (typeof id !== 'string' || id.length < 3 || id.length > 64 || !RULE_ID.test(id))
      throw new TypeError(`[geo] invalid rule id "${String(id)}": use capital letters, digits and dashes, e.g. ACME-NO-LOREM`)
    if (BUILTIN_RULE_IDS.includes(id) || RESERVED_PREFIXES.some((p) => id.startsWith(p)))
      throw new TypeError(`[geo] rule id "${id}" is reserved for the plugin's own checks; use your own prefix`)
    if (seen.has(id)) throw new TypeError(`[geo] duplicate rule id "${id}"`)
    if (typeof rule.check !== 'function') throw new TypeError(`[geo] rule "${id}" has no check() function`)
    seen.add(id)
  }
  return [...rules]
}

function invalid(id: string, why: string): CheckResult {
  return { ruleId: id, status: 'error', message: `Custom rule returned an invalid result: ${why}.`, suggestion: 'Fix the rule; its result is not shown.' }
}

/** Checks a rule's return value and turns it into a check result (or null for nothing to show). */
export function normalizeOutcome(id: string, value: unknown): CheckResult | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return invalid(id, `expected an object, got ${Array.isArray(value) ? 'an array' : typeof value}`)
  const o = value as Record<string, unknown>
  if (!STATUSES.has(o.status as CheckStatus)) return invalid(id, `status must be pass, warning, error or notApplicable`)
  if (typeof o.message !== 'string' || !o.message.trim()) return invalid(id, 'message must be a non-empty string')
  if (o.suggestion !== undefined && typeof o.suggestion !== 'string') return invalid(id, 'suggestion must be a string')
  if (o.fieldPath !== undefined && typeof o.fieldPath !== 'string') return invalid(id, 'fieldPath must be a string')
  const out: CheckResult = {
    ruleId: id,
    status: o.status as CheckStatus,
    message: o.message.slice(0, 500),
    suggestion: typeof o.suggestion === 'string' ? o.suggestion.slice(0, 500) : 'Custom rule.',
  }
  if (typeof o.fieldPath === 'string' && o.fieldPath) out.fieldPath = o.fieldPath.slice(0, 200)
  return out
}

/** Runs custom rules in registration order, after the built-in checks. Never throws. */
export async function runRules(
  rules: readonly GeoRule<any>[],
  ctx: Omit<RuleContext, 'params' | 'signal'>,
  options: RuleRunOptions = {},
): Promise<CheckResult[]> {
  const timeoutMs = options.timeoutMs ?? 2000
  const results: CheckResult[] = []
  for (const rule of rules) {
    if (rule.collections && !rule.collections.includes(ctx.collection)) continue
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve('timeout')
        }, timeoutMs)
      })
      const outcome = await Promise.race([Promise.resolve().then(() => rule.check({ ...ctx, params: rule.params ?? {}, signal: controller.signal })), timeout])
      if (outcome === 'timeout') {
        results.push({ ruleId: rule.id, status: 'error', message: `Custom rule timed out after ${timeoutMs} ms.`, suggestion: 'Make the rule faster or raise `rulesTimeoutMs`.' })
        continue
      }
      const normalized = normalizeOutcome(rule.id, outcome)
      if (normalized) results.push(normalized)
    } catch (error) {
      const message = String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 200)
      results.push({ ruleId: rule.id, status: 'error', message: `Custom rule threw: ${message}`, suggestion: 'Fix the rule; the built-in checks are unaffected.' })
    } finally {
      clearTimeout(timer)
    }
  }
  return results
}

/** Appends custom rule results to an inspection. */
export async function withRules(
  inspection: Inspection,
  rules: readonly GeoRule<any>[] | undefined,
  ctx: { values: Record<string, any>; state: DocumentState; collection: string },
  options?: RuleRunOptions,
): Promise<Inspection> {
  if (!rules?.length) return inspection
  const extra = await runRules(rules, { ...ctx, sources: inspection.sources, document: inspection.document, markdown: inspection.contentMarkdown }, options)
  return { ...inspection, checks: [...inspection.checks, ...extra] }
}
