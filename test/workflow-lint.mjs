// Static checks for .github/workflows: what can be verified without running GitHub Actions.
// It parses with the YAML 1.2 parser that the pinned playwright package already ships, so no dependency is added.
import { createRequire } from 'node:module'

const requireHere = createRequire(import.meta.url)
const { yaml } = createRequire(requireHere.resolve('playwright'))('playwright-core/lib/utilsBundle')

const EVENTS = ['push', 'pull_request', 'pull_request_target', 'workflow_dispatch', 'workflow_call', 'workflow_run', 'schedule', 'release', 'issue_comment', 'issues', 'merge_group', 'create', 'delete']
const WORKFLOW_KEYS = ['name', 'run-name', 'on', 'permissions', 'env', 'defaults', 'concurrency', 'jobs', 'cache-mode']
const JOB_KEYS = ['name', 'needs', 'if', 'runs-on', 'permissions', 'environment', 'concurrency', 'outputs', 'env', 'defaults', 'steps', 'timeout-minutes', 'strategy', 'continue-on-error', 'container', 'services', 'cache-mode']
// the only keys GitHub accepts on a job that calls a reusable workflow
const CALLER_KEYS = ['name', 'uses', 'with', 'secrets', 'strategy', 'needs', 'if', 'concurrency', 'permissions', 'cache-mode']
const STEP_KEYS = ['id', 'if', 'name', 'uses', 'run', 'shell', 'with', 'env', 'continue-on-error', 'timeout-minutes', 'working-directory']
const PERMISSION_SCOPES = ['actions', 'attestations', 'checks', 'contents', 'deployments', 'discussions', 'id-token', 'issues', 'models', 'packages', 'pages', 'pull-requests', 'repository-projects', 'security-events', 'statuses']
const CACHE_MODES = ['read', 'write', 'write-only', 'none']
const GITHUB_PROPS = ['action', 'action_path', 'action_ref', 'action_repository', 'action_status', 'actor', 'actor_id', 'api_url', 'base_ref', 'env', 'event', 'event_name', 'event_path', 'graphql_url', 'head_ref', 'job', 'path', 'ref', 'ref_name', 'ref_protected', 'ref_type', 'repository', 'repository_id', 'repository_owner', 'repository_owner_id', 'repositoryUrl', 'retention_days', 'run_id', 'run_number', 'run_attempt', 'secret_source', 'server_url', 'sha', 'token', 'triggering_actor', 'workflow', 'workflow_ref', 'workflow_sha', 'workspace']
const FUNCTIONS = ['contains', 'startsWith', 'endsWith', 'format', 'join', 'toJSON', 'fromJSON', 'hashFiles']
const STATUS_FUNCTIONS = ['success', 'failure', 'always', 'cancelled']
const LITERALS = ['true', 'false', 'null']

// Which contexts GitHub makes available where; a context used outside its place is an error at run time, not at push
const STEP_CONTEXTS = ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'secrets', 'steps', 'inputs']
const PLACES = {
  'workflow.run-name': ['github', 'inputs', 'vars'],
  'workflow.concurrency': ['github', 'inputs', 'vars'],
  'workflow.env': ['github', 'secrets', 'inputs', 'vars'],
  'workflow.call-output': ['github', 'jobs', 'vars', 'inputs'],
  'workflow.input-default': ['github', 'inputs', 'vars'],
  'job.if': ['github', 'needs', 'vars', 'inputs'],
  'job.runs-on': ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs'],
  'job.env': ['github', 'needs', 'strategy', 'matrix', 'vars', 'secrets', 'inputs'],
  'job.concurrency': ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs'],
  'job.outputs': ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'secrets', 'steps', 'inputs'],
  'job.environment': ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs'],
  'job.environment.url': ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'steps', 'inputs'],
  'job.other': ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs'],
  'job.container': ['github', 'needs', 'strategy', 'matrix', 'env', 'vars', 'secrets', 'inputs'],
  'job.with': ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs'],
  'job.secrets': ['github', 'needs', 'strategy', 'matrix', 'secrets', 'vars', 'inputs'],
  'step.if': ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'steps', 'inputs'],
  'step.other': STEP_CONTEXTS,
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const list = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value])

// every ${{ }} in a string; an `if:` without the braces is one expression as a whole
export function expressions(value, isIf) {
  if (typeof value !== 'string') return []
  const found = []
  const re = /\$\{\{([\s\S]*?)\}\}/g
  let match
  while ((match = re.exec(value))) found.push(match[1].trim())
  if (isIf && !found.length) found.push(value.trim())
  if (/\$\{\{/.test(value.replace(re, ''))) found.push('${{ unterminated')
  return found
}

// The references in one expression, with string literals taken out first so 'refs/heads/main' is not read as a path
export function references(expression) {
  const problems = []
  let bare = ''
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i]
    if (ch === "'") {
      let end = i + 1
      for (;;) {
        if (end >= expression.length) {
          problems.push('a string is not closed')
          break
        }
        if (expression[end] === "'" && expression[end + 1] === "'") end += 2
        else if (expression[end] === "'") break
        else end++
      }
      bare += "''"
      i = end
    } else if (ch === '"') {
      problems.push('strings take single quotes in expressions')
      bare += ch
    } else bare += ch
  }
  let depth = 0
  for (const ch of bare) {
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth--
    if (depth < 0) break
  }
  if (depth !== 0) problems.push('brackets do not balance')
  if (/(^|[^=!<>])=(?!=)/.test(bare)) problems.push('a single = is not an operator; use ==')
  const refs = []
  const re = /[A-Za-z_][A-Za-z0-9_-]*(?:\.(?:\*|[A-Za-z_][A-Za-z0-9_-]*)|\[[^\]]*\])*(\s*\()?/g
  let match
  while ((match = re.exec(bare))) {
    const before = bare[match.index - 1]
    if (before && /[\w.]/.test(before)) continue
    const call = Boolean(match[1])
    const text = call ? match[0].slice(0, match[0].indexOf('(')).trim() : match[0]
    refs.push({ text, parts: text.replace(/\[[^\]]*\]/g, '').split('.'), call })
  }
  return { problems, refs }
}

export function parse(name, text) {
  const doc = yaml.parseDocument(text, { uniqueKeys: true, prettyErrors: false })
  const problems = [...doc.errors, ...doc.warnings].map((error) => `${name}: YAML: ${error.message.split('\n')[0]}`)
  return { workflow: problems.length ? null : doc.toJS(), problems }
}

function triggers(workflow) {
  const on = workflow.on
  if (typeof on === 'string') return { [on]: null }
  if (Array.isArray(on)) return Object.fromEntries(on.map((event) => [event, null]))
  return isObject(on) ? on : {}
}

function inputsOf(workflow) {
  const on = triggers(workflow)
  return { ...((on.workflow_dispatch && on.workflow_dispatch.inputs) || {}), ...((on.workflow_call && on.workflow_call.inputs) || {}) }
}

function callOutputsOf(workflow) {
  const call = triggers(workflow).workflow_call
  return (call && call.outputs) || {}
}

// Checks one workflow file against itself and against the other files it calls. `files` maps file name to parsed workflow
export function lintWorkflow(name, workflow, files) {
  const problems = []
  const say = (where, message) => problems.push(`${name}: ${where}: ${message}`)

  for (const key of Object.keys(workflow)) if (!WORKFLOW_KEYS.includes(key)) say('top level', `unknown key ${key}`)
  for (const key of ['name', 'on', 'jobs']) if (workflow[key] === undefined) say('top level', `${key} is missing`)
  const on = triggers(workflow)
  for (const event of Object.keys(on)) if (!EVENTS.includes(event)) say('on', `unknown event ${event}`)
  const inputs = inputsOf(workflow)
  for (const [id, input] of Object.entries(inputs)) {
    if (!isObject(input)) continue
    if (input.type && !['boolean', 'number', 'string', 'choice', 'environment'].includes(input.type)) say(`input ${id}`, `unknown type ${input.type}`)
    if (input.type === 'boolean' && input.default !== undefined && typeof input.default !== 'boolean') say(`input ${id}`, 'a boolean input needs a boolean default')
  }
  checkPermissions(workflow.permissions, 'permissions', say)
  checkCacheMode(workflow['cache-mode'], 'cache-mode', say)

  const jobs = isObject(workflow.jobs) ? workflow.jobs : {}
  if (!Object.keys(jobs).length) say('jobs', 'no jobs')

  // the context a reference resolves against
  const scope = { inputs, jobs, files, name }
  const check = (where, value, place, extra) => {
    const visit = (text, isIf) => {
      for (const expression of expressions(text, isIf)) checkExpression(expression, place, { ...scope, ...extra }, (message) => say(where, `${message} in \${{ ${expression} }}`))
    }
    walk(value, visit, place === 'job.if' || place === 'step.if')
  }
  check('run-name', workflow['run-name'], 'workflow.run-name')
  check('concurrency', workflow.concurrency, 'workflow.concurrency')
  check('env', workflow.env, 'workflow.env')
  for (const [id, output] of Object.entries(callOutputsOf(workflow))) check(`workflow_call output ${id}`, output && output.value, 'workflow.call-output')
  for (const [id, input] of Object.entries(inputs)) check(`input ${id}`, input && input.default, 'workflow.input-default')

  for (const [id, job] of Object.entries(jobs)) {
    const where = `job ${id}`
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) say(where, 'a job id must start with a letter or _ and hold only letters, digits, - and _')
    if (!isObject(job)) {
      say(where, 'is not a mapping')
      continue
    }
    const needs = list(job.needs)
    for (const need of needs) if (!jobs[need]) say(where, `needs ${need}, which is not a job here`)
    if (needs.includes(id)) say(where, 'needs itself')
    checkPermissions(job.permissions, `${where} permissions`, say)
    checkCacheMode(job['cache-mode'], `${where} cache-mode`, say)
    const matrix = job.strategy && isObject(job.strategy.matrix) ? job.strategy.matrix : {}
    const matrixKeys = new Set(Object.keys(matrix).filter((key) => key !== 'include' && key !== 'exclude'))
    for (const entry of list(matrix.include)) if (isObject(entry)) for (const key of Object.keys(entry)) matrixKeys.add(key)
    const jobScope = { job, jobId: id, needs, matrixKeys }

    check(`${where} if`, job.if, 'job.if', jobScope)
    check(`${where} concurrency`, job.concurrency, 'job.concurrency', jobScope)
    check(`${where} strategy`, job.strategy, 'job.other', jobScope)

    if (job.uses !== undefined) {
      for (const key of Object.keys(job)) if (!CALLER_KEYS.includes(key)) say(where, `${key} is not allowed on a job that calls a reusable workflow`)
      const target = /^\.\/\.github\/workflows\/([^/]+\.ya?ml)$/.exec(job.uses)
      if (!target) {
        if (!/^[\w.-]+\/[\w.-]+\/\.github\/workflows\/[^@]+@.+$/.test(job.uses)) say(where, `uses ${job.uses} is not a reusable workflow reference`)
        continue
      }
      const called = files[target[1]]
      if (!called) {
        say(where, `calls ${target[1]}, which is not in .github/workflows`)
        continue
      }
      const call = triggers(called).workflow_call
      if (call === undefined) {
        say(where, `calls ${target[1]}, which has no workflow_call trigger`)
        continue
      }
      const declared = (call && call.inputs) || {}
      const given = isObject(job.with) ? job.with : {}
      for (const [key, value] of Object.entries(given)) {
        const input = declared[key]
        if (!input) say(where, `passes ${key}, which ${target[1]} does not declare`)
        else if (input.type === 'boolean' && typeof value !== 'boolean' && !(typeof value === 'string' && value.includes('${{'))) say(where, `${key} must be a boolean`)
      }
      for (const [key, input] of Object.entries(declared)) if (input && input.required && !(key in given)) say(where, `does not pass ${key}, which ${target[1]} requires`)
      check(`${where} with`, job.with, 'job.with', jobScope)
      check(`${where} secrets`, job.secrets, 'job.secrets', jobScope)
      continue
    }

    for (const key of Object.keys(job)) if (!JOB_KEYS.includes(key)) say(where, `unknown key ${key}`)
    if (job['runs-on'] === undefined) say(where, 'runs-on is missing')
    if (!Array.isArray(job.steps) || !job.steps.length) {
      say(where, 'has no steps')
      continue
    }
    const stepIds = []
    job.steps.forEach((step, index) => {
      if (isObject(step) && step.id !== undefined) {
        if (stepIds.includes(step.id)) say(`${where} step ${index + 1}`, `the id ${step.id} is used twice`)
        stepIds.push(step.id)
      }
    })
    const allSteps = { ...jobScope, stepIds, stepsBefore: stepIds }
    check(`${where} runs-on`, job['runs-on'], 'job.runs-on', jobScope)
    check(`${where} env`, job.env, 'job.env', jobScope)
    check(`${where} timeout-minutes`, job['timeout-minutes'], 'job.other', jobScope)
    check(`${where} container`, job.container, 'job.container', jobScope)
    check(`${where} outputs`, job.outputs, 'job.outputs', allSteps)
    if (isObject(job.environment)) {
      check(`${where} environment`, job.environment.name, 'job.environment', jobScope)
      check(`${where} environment url`, job.environment.url, 'job.environment.url', allSteps)
    } else check(`${where} environment`, job.environment, 'job.environment', jobScope)

    const seen = []
    job.steps.forEach((step, index) => {
      const at = `${where} step ${(isObject(step) && (step.id || step.name)) || index + 1}`
      if (!isObject(step)) {
        say(at, 'is not a mapping')
        return
      }
      for (const key of Object.keys(step)) if (!STEP_KEYS.includes(key)) say(at, `unknown key ${key}`)
      if ((step.uses === undefined) === (step.run === undefined)) say(at, 'needs exactly one of uses and run')
      const stepScope = { ...jobScope, stepIds, stepsBefore: seen.slice() }
      check(`${at} if`, step.if, 'step.if', stepScope)
      for (const key of ['name', 'run', 'env', 'with', 'working-directory', 'timeout-minutes', 'continue-on-error', 'shell']) check(`${at} ${key}`, step[key], 'step.other', stepScope)
      if (step.id !== undefined) seen.push(step.id)
    })
  }

  // a cycle in needs is refused by GitHub when the file is pushed
  const state = {}
  const visit = (id, path) => {
    if (state[id] === 'done' || !jobs[id]) return
    if (state[id] === 'active') {
      say('jobs', `needs form a cycle: ${[...path, id].join(' -> ')}`)
      return
    }
    state[id] = 'active'
    for (const need of list(jobs[id] && jobs[id].needs)) visit(need, [...path, id])
    state[id] = 'done'
  }
  for (const id of Object.keys(jobs)) visit(id, [])
  return problems
}

function checkPermissions(permissions, where, say) {
  if (permissions === undefined || permissions === null) return
  if (typeof permissions === 'string') {
    if (!['read-all', 'write-all'].includes(permissions)) say(where, `unknown value ${permissions}`)
    return
  }
  if (!isObject(permissions)) return say(where, 'must be a mapping')
  for (const [scope, level] of Object.entries(permissions)) {
    if (!PERMISSION_SCOPES.includes(scope)) say(where, `unknown scope ${scope}`)
    if (!['read', 'write', 'none'].includes(level)) say(where, `${scope} must be read, write or none`)
    if (scope === 'id-token' && level === 'read') say(where, 'id-token is write or none')
  }
}

function checkCacheMode(mode, where, say) {
  if (mode !== undefined && !CACHE_MODES.includes(mode)) say(where, `must be one of ${CACHE_MODES.join(', ')}`)
}

function walk(value, visit, isIf) {
  if (typeof value === 'string') visit(value, isIf)
  else if (Array.isArray(value)) value.forEach((item) => walk(item, visit))
  else if (isObject(value)) for (const item of Object.values(value)) walk(item, visit)
}

function checkExpression(expression, place, scope, say) {
  const { problems, refs } = references(expression)
  problems.forEach(say)
  const allowed = PLACES[place]
  for (const ref of refs) {
    const [root, ...rest] = ref.parts
    if (ref.call) {
      if (STATUS_FUNCTIONS.includes(root)) {
        if (place !== 'job.if' && place !== 'step.if') say(`${root}() belongs in an if`)
      } else if (root === 'hashFiles') {
        if (!place.startsWith('step.')) say('hashFiles() is only available in steps')
      } else if (!FUNCTIONS.includes(root)) say(`unknown function ${root}()`)
      continue
    }
    if (LITERALS.includes(root) && !rest.length) continue
    if (!allowed.includes(root)) {
      say(STEP_CONTEXTS.includes(root) || root === 'jobs' ? `the ${root} context is not available here` : `unknown name ${ref.text}`)
      continue
    }
    resolve(root, rest, scope, say)
  }
}

function resolve(root, rest, scope, say) {
  if (root === 'github') {
    if (!rest.length) return
    if (!GITHUB_PROPS.includes(rest[0])) say(`github.${rest[0]} is not a property of github`)
  } else if (root === 'needs') {
    const [id, kind, output] = rest
    if (!id || id === '*') return
    if (!scope.needs.includes(id)) return say(`needs.${id} is not in this job's needs`)
    if (kind === 'result' || kind === undefined) return
    if (kind !== 'outputs') return say(`needs.${id}.${kind} is neither result nor outputs`)
    const outputs = outputsOfJob(scope.jobs[id], scope.files)
    if (output && outputs && !(output in outputs)) say(`job ${id} has no output ${output}`)
  } else if (root === 'steps') {
    const [id, kind] = rest
    if (!id) return
    if (!scope.stepIds || !scope.stepIds.includes(id)) return say(`no step has the id ${id}`)
    if (!scope.stepsBefore.includes(id)) say(`step ${id} runs after this one`)
    if (kind && !['outputs', 'outcome', 'conclusion'].includes(kind)) say(`steps.${id}.${kind} is not outputs, outcome or conclusion`)
  } else if (root === 'inputs') {
    if (rest[0] && !(rest[0] in scope.inputs)) say(`there is no input ${rest[0]}`)
  } else if (root === 'matrix') {
    if (rest[0] && !scope.matrixKeys.has(rest[0])) say(`the matrix has no ${rest[0]}`)
  } else if (root === 'jobs') {
    const [id, kind, output] = rest
    const job = scope.jobs[id]
    if (!job) return say(`there is no job ${id}`)
    if (kind !== 'outputs') return say(`jobs.${id}.${kind} is not outputs`)
    const outputs = outputsOfJob(job, scope.files)
    if (output && outputs && !(output in outputs)) say(`job ${id} has no output ${output}`)
  }
}

// a job's outputs, or for a job that calls a workflow in this repository, that workflow's outputs; null when unknowable
function outputsOfJob(job, files) {
  if (!isObject(job)) return {}
  if (job.uses === undefined) return job.outputs || {}
  const target = /^\.\/\.github\/workflows\/([^/]+)$/.exec(job.uses)
  return target && files[target[1]] ? callOutputsOf(files[target[1]]) : null
}

// Parses every file and runs every check; returns one line per problem
export function lintAll(texts) {
  const problems = []
  const files = {}
  for (const [name, text] of Object.entries(texts)) {
    const parsed = parse(name, text)
    problems.push(...parsed.problems)
    if (parsed.workflow) files[name] = parsed.workflow
  }
  for (const [name, workflow] of Object.entries(files)) problems.push(...lintWorkflow(name, workflow, files))
  return { problems, files }
}

// Jobs allowed to hold a write permission, and which ones; everything else reads at most
const WRITERS = {
  'release.yml': { publish: { 'id-token': 'write' }, 'github-release': { contents: 'write' } },
  'pages.yml': { deploy: { pages: 'write', 'id-token': 'write' } },
}
const UNTRUSTED_EVENTS = ['pull_request_target', 'workflow_run', 'issue_comment']

// The supply-chain and credential rules from the workflow audit. `texts` holds the raw files, for the comments YAML drops
export function hardening(texts, files) {
  const problems = []
  for (const [name, text] of Object.entries(texts)) {
    text.split('\n').forEach((line, index) => {
      const match = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line)
      if (!match || match[1].startsWith('./')) return
      const at = `${name}:${index + 1}`
      if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(match[1])) problems.push(`${at}: ${match[1]} is not pinned to a full commit SHA`)
      else if (!/^\s+# v\d+\.\d+\.\d+\s*$/.test(match[2])) problems.push(`${at}: ${match[1]} needs its release tag in a comment, as # vX.Y.Z`)
    })
  }
  for (const [name, workflow] of Object.entries(files)) {
    const say = (where, message) => problems.push(`${name}: ${where}: ${message}`)
    const on = isObject(workflow.on) ? workflow.on : Object.fromEntries(list(workflow.on).map((event) => [event, null]))
    for (const event of UNTRUSTED_EVENTS) if (event in on) say('on', `${event} runs with the base repository's credentials; do not use it`)
    const top = workflow.permissions
    if (top === undefined) say('permissions', 'set them at the top, so a new job starts with nothing it did not ask for')
    else if (typeof top === 'string' || Object.values(top || {}).some((level) => level === 'write')) say('permissions', 'nothing may be written with the permissions every job inherits')
    const writers = WRITERS[name] || {}
    for (const [id, job] of Object.entries(isObject(workflow.jobs) ? workflow.jobs : {})) {
      const where = `job ${id}`
      const granted = isObject(job.permissions) ? job.permissions : {}
      const writes = Object.fromEntries(Object.entries(granted).filter(([, level]) => level === 'write'))
      const allowed = writers[id] || {}
      for (const scope of Object.keys(writes)) if (allowed[scope] !== 'write') say(where, `${scope}: write is not on the list of jobs that may write`)
      if (job.secrets === 'inherit') say(where, 'secrets: inherit hands every secret to the called workflow')
      if (job.uses !== undefined) continue
      if (job['timeout-minutes'] === undefined) say(where, 'timeout-minutes is missing; the default is six hours of billed time')
      const given = isObject(job.container) ? job.container.image : job.container
      // the one expression allowed: CI_LINUX_RUNNER set means no container, unset means this image, which must be pinned
      const switched = typeof given === 'string' && /^\$\{\{ vars\.CI_LINUX_RUNNER == '' && '([^']+)' \|\| '' \}\}$/.exec(given)
      const image = switched ? switched[1] : given
      if (image !== undefined && !/@sha256:[0-9a-f]{64}$/.test(image)) say(where, `the container ${image} is not pinned by digest`)
      for (const step of list(job.steps)) {
        if (!isObject(step)) continue
        const label = `${where} step ${step.id || step.name || step.uses || step.run}`
        if (typeof step.run === 'string' && step.run.includes('${{')) say(label, 'an expression inside run: is pasted into the shell; pass it through env:')
        if (/^actions\/checkout@/.test(step.uses || '') && !(isObject(step.with) && step.with['persist-credentials'] === false)) say(label, 'checkout must set persist-credentials: false, so the token is not left in .git/config')
      }
    }
  }
  return problems
}

// A workflow that can write or deploy anything restores no cache another run could have written
export function privileged(workflow) {
  return Object.values(isObject(workflow.jobs) ? workflow.jobs : {}).some((job) => isObject(job.permissions) && Object.values(job.permissions).includes('write'))
}
