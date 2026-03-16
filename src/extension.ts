import * as vscode from 'vscode'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

interface ReviewComment {
  file: string
  line: number
  endLine: number
  column: number
  author: string
  body: string
  suggestion?: string
  source: 'local' | 'pr'
  outdated?: boolean
  url?: string
}

interface ToolInput {
  source?: 'local' | 'pr' | 'all'
}

interface StartReviewInput {
  scope?: 'all' | 'staged' | 'unstaged'
  waitForComments?: boolean
}

let cachedComments: ReviewComment[] = []
const debugLog: string[] = []

function log(msg: string): void {
  debugLog.push(msg)
}

/**
 * Walk the object graph from Copilot Chat extension internals
 * to find the review service that holds comment threads.
 *
 * The review service (Lde in minified source) has:
 *   _commentController.id === "github-copilot-review"
 *   _comments: Array<{comment, thread}>
 */
function findReviewService(): unknown | null {
  const visited = new WeakSet()

  function walk(obj: unknown, depth: number, path: string): unknown | null {
    if (depth > 15 || !obj || typeof obj !== 'object') return null
    if (visited.has(obj as object)) return null
    visited.add(obj as object)

    const o = obj as Record<string, unknown>

    // Check if this is the review service
    try {
      const ctrl = o._commentController as Record<string, unknown> | undefined
      if (ctrl && ctrl.id === 'github-copilot-review' && Array.isArray(o._comments)) {
        log('[walk] FOUND review service at: ' + path)
        return o
      }
    } catch {
      // Skip property access errors
    }

    // Walk Maps
    if (obj instanceof Map) {
      let i = 0
      for (const [, value] of obj) {
        if (value && typeof value === 'object') {
          const result = walk(value, depth + 1, path + '.Map[' + i + ']')
          if (result) return result
        }
        if (++i > 100) break
      }
      return null
    }

    // Skip Sets, WeakMaps, WeakSets
    if (obj instanceof Set || obj instanceof WeakMap || obj instanceof WeakSet) return null

    // Walk arrays (limited)
    if (Array.isArray(obj)) {
      for (let i = 0; i < Math.min(obj.length, 20); i++) {
        if (obj[i] && typeof obj[i] === 'object') {
          const result = walk(obj[i], depth + 1, path + '[' + i + ']')
          if (result) return result
        }
      }
      return null
    }

    // Walk object properties, skipping noise
    const skipKeys = new Set([
      '_disposables', '_listeners', '_deliveryQueue', '_leakageMon', '_perfMon',
      'prototype', '__proto__', '_store', '_event',
      '_onDidChange', '_onDidChangeState', '_onDidOpenRepository',
      '_onDidCloseRepository', '_onDidPublish', '_onDidChangeFolderRepositories',
      '_onDidLoadAnyRepositories', '_onDidChangeAnyPullRequests',
      '_onDidAddPullRequest', '_onDidAddAnyGitHubRepository',
      '_subs', '_previousWorktrees', '_mentionableUsers',
      '_fetchMentionableUsersPromise', '_fetchAssignableUsersPromise',
      '_fetchTeamReviewersPromise', '_credentialStore', '_telemetry',
    ])

    let keys: string[]
    try {
      keys = Object.keys(o)
    } catch {
      return null
    }

    for (const key of keys.slice(0, 50)) {
      if (skipKeys.has(key)) continue
      try {
        const val = o[key]
        if (val && typeof val === 'object') {
          const result = walk(val, depth + 1, path + '.' + key)
          if (result) return result
        }
      } catch {
        // Skip
      }
    }
    return null
  }

  // Strategy 1: Walk from Copilot Chat API
  const copilotChat = vscode.extensions.getExtension('github.copilot-chat')
  if (copilotChat?.isActive && copilotChat.exports) {
    log('[find] Walking from copilot-chat exports...')
    try {
      const api = typeof copilotChat.exports.getAPI === 'function'
        ? copilotChat.exports.getAPI()
        : copilotChat.exports
      const result = walk(api, 0, 'copilotAPI')
      if (result) return result
    } catch (err: unknown) {
      log('[find] copilot-chat API walk error: ' + (err instanceof Error ? err.message : String(err)))
    }
    const result = walk(copilotChat.exports, 0, 'copilotExports')
    if (result) return result
  }

  // Strategy 2: Walk from PR extension
  const prExt = vscode.extensions.getExtension('github.vscode-pull-request-github')
  if (prExt?.isActive && prExt.exports) {
    log('[find] Walking from PR extension exports...')
    const result = walk(prExt.exports, 0, 'prExports')
    if (result) return result
  }

  // Strategy 3: Walk require.cache for copilot modules
  log('[find] Walking require.cache...')
  const cache = require.cache
  if (cache) {
    for (const key of Object.keys(cache)) {
      if (!key.includes('copilot-chat')) continue
      const mod = cache[key]
      if (!mod?.exports) continue
      log('[find] Checking cached module: ' + key.substring(key.lastIndexOf('/') + 1))
      const result = walk(mod.exports, 0, 'cache.' + key.substring(key.lastIndexOf('/') + 1))
      if (result) return result
    }
  }

  log('[find] Review service not found via object graph walk')
  return null
}

function extractComments(service: unknown): ReviewComment[] {
  const comments: ReviewComment[] = []
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''

  try {
    const svc = service as Record<string, unknown>
    const entries = svc._comments as Array<Record<string, unknown>>
    if (!Array.isArray(entries)) return comments

    log('[extract] Found ' + entries.length + ' comment entries')

    for (const entry of entries) {
      const comment = entry.comment as Record<string, unknown> | undefined
      if (!comment) continue

      const uri = comment.uri as { fsPath?: string; path?: string } | undefined
      const filePath = uri?.fsPath ?? uri?.path ?? 'unknown'
      const relativePath = typeof filePath === 'string' && filePath.startsWith(workspaceRoot)
        ? filePath.slice(workspaceRoot.length + 1)
        : String(filePath)

      const range = comment.range as {
        start?: { line?: number; character?: number }
        end?: { line?: number }
      } | undefined

      let body = ''
      const rawBody = comment.body
      if (typeof rawBody === 'string') {
        body = rawBody
      } else if (rawBody && typeof rawBody === 'object' && 'value' in (rawBody as Record<string, unknown>)) {
        body = String((rawBody as Record<string, unknown>).value)
      }

      let suggestion: string | undefined
      const rawSuggestion = comment.suggestion as Record<string, unknown> | undefined
      if (rawSuggestion) {
        if ('edits' in rawSuggestion && Array.isArray(rawSuggestion.edits)) {
          suggestion = (rawSuggestion.edits as Array<Record<string, unknown>>)
            .map(edit => String(edit.newText ?? edit.text ?? ''))
            .join('\n')
        }
        if ('markdown' in rawSuggestion && typeof rawSuggestion.markdown === 'string') {
          suggestion = (suggestion ? suggestion + '\n---\n' : '') + rawSuggestion.markdown
        }
      }

      comments.push({
        file: relativePath,
        line: (range?.start?.line ?? 0) + 1,
        endLine: (range?.end?.line ?? range?.start?.line ?? 0) + 1,
        column: (range?.start?.character ?? 0) + 1,
        author: 'copilot',
        body,
        suggestion,
        source: 'local',
      })
    }
  } catch (err: unknown) {
    log('[extract] Error: ' + (err instanceof Error ? err.message : String(err)))
  }

  return comments
}

async function readCommentsFromFile(): Promise<ReviewComment[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders
  if (!workspaceFolders?.length) return []

  const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, '.review-comments.json')

  try {
    const content = await vscode.workspace.fs.readFile(fileUri)
    const parsed = JSON.parse(Buffer.from(content).toString('utf-8'))
    if (Array.isArray(parsed)) return parsed as ReviewComment[]
    return []
  } catch {
    return []
  }
}

// Intercepted comment threads from monkey-patching
const interceptedThreads: vscode.CommentThread[] = []

function extractFromIntercepted(): ReviewComment[] {
  const comments: ReviewComment[] = []
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''

  for (const thread of interceptedThreads) {
      const filePath = thread.uri.fsPath
      const relativePath = filePath.startsWith(workspaceRoot)
        ? filePath.slice(workspaceRoot.length + 1)
        : filePath

      const range = thread.range
      for (const comment of thread.comments) {
        const body = typeof comment.body === 'string'
          ? comment.body
          : comment.body.value

        comments.push({
          file: relativePath,
          line: range ? range.start.line + 1 : 1,
          endLine: range ? range.end.line + 1 : 1,
          column: range ? range.start.character + 1 : 1,
          author: comment.author.name,
          body,
          source: 'local',
        })
      }
    }
  return comments
}

/**
 * Get workspace cwd for running gh commands.
 */
function getWorkspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

/**
 * Run a gh CLI command and return parsed JSON output.
 */
async function ghJson<T>(args: string[]): Promise<T | null> {
  const cwd = getWorkspaceCwd()
  if (!cwd) {
    log('[gh] No workspace folder')
    return null
  }

  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    })
    return JSON.parse(stdout) as T
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log('[gh] Command failed: gh ' + args.join(' ') + ' => ' + message)
    return null
  }
}

interface GhPrInfo {
  number: number
  headRefName: string
  baseRefName: string
  url: string
}

interface GhPrComment {
  path: string
  line: number | null
  startLine: number | null
  body: string
  author: { login: string }
  url: string
  outdated: boolean
  diffHunk: string
}

/**
 * Detect the current PR using gh CLI.
 */
async function getCurrentPr(): Promise<GhPrInfo | null> {
  log('[gh] Detecting current PR...')
  const result = await ghJson<GhPrInfo>(
    ['pr', 'view', '--json', 'number,headRefName,baseRefName,url']
  )
  if (result) {
    log('[gh] Found PR #' + result.number + ' (' + result.headRefName + ')')
  }
  return result
}

/**
 * Fetch all review comments on the current PR via gh api.
 * Uses the pulls/comments endpoint which returns review comments (inline comments).
 */
async function fetchPrReviewComments(prNumber: number): Promise<ReviewComment[]> {
  log('[gh] Fetching review comments for PR #' + prNumber + '...')

  const ghComments = await ghJson<GhPrComment[]>([
    'api',
    'repos/{owner}/{repo}/pulls/' + prNumber + '/comments',
    '--paginate',
    '--jq', '.',
  ])

  if (!ghComments || !Array.isArray(ghComments)) {
    log('[gh] No review comments returned')
    return []
  }

  log('[gh] Got ' + ghComments.length + ' PR review comment(s)')

  return ghComments.map(c => ({
    file: c.path,
    line: c.line ?? c.startLine ?? 1,
    endLine: c.line ?? c.startLine ?? 1,
    column: 1,
    author: c.author?.login ?? 'unknown',
    body: c.body,
    source: 'pr' as const,
    outdated: c.outdated,
    url: c.url,
  }))
}

/**
 * Fetch top-level PR issue comments (non-inline) via gh api.
 */
async function fetchPrIssueComments(prNumber: number): Promise<ReviewComment[]> {
  log('[gh] Fetching issue comments for PR #' + prNumber + '...')

  interface IssueComment {
    body: string
    author: { login: string }
    url: string
  }

  const ghComments = await ghJson<IssueComment[]>([
    'api',
    'repos/{owner}/{repo}/issues/' + prNumber + '/comments',
    '--paginate',
    '--jq', '.',
  ])

  if (!ghComments || !Array.isArray(ghComments)) return []

  log('[gh] Got ' + ghComments.length + ' PR issue comment(s)')

  return ghComments
    .filter(c => c.body && c.body.trim().length > 0)
    .map(c => ({
      file: '',
      line: 0,
      endLine: 0,
      column: 0,
      author: c.author?.login ?? 'unknown',
      body: c.body,
      source: 'pr' as const,
      url: c.url,
    }))
}

/**
 * Fetch all PR comments (review + issue) via gh CLI.
 */
async function fetchAllPrComments(): Promise<ReviewComment[]> {
  const pr = await getCurrentPr()
  if (!pr) return []

  const [reviewComments, issueComments] = await Promise.all([
    fetchPrReviewComments(pr.number),
    fetchPrIssueComments(pr.number),
  ])

  return [...reviewComments, ...issueComments]
}

/**
 * Monkey-patch vscode.comments.createCommentController to intercept
 * the Copilot review controller's createCommentThread calls.
 */
function setupInterceptor(): void {
  try {
    const original = vscode.comments.createCommentController

    const wrapped = function (id: string, label: string): vscode.CommentController {
      log('[intercept] createCommentController: id=' + id + ', label=' + label)
      const controller = original.call(vscode.comments, id, label)

      if (id === 'github-copilot-review') {
        log('[intercept] Captured Copilot review controller!')
        const origCreate = controller.createCommentThread.bind(controller)
        controller.createCommentThread = function (
          uri: vscode.Uri,
          range: vscode.Range,
          comments: readonly vscode.Comment[]
        ): vscode.CommentThread {
          const thread = origCreate(uri, range, comments)
          log('[intercept] Captured thread: ' + uri.fsPath + ':' + range.start.line)
          interceptedThreads.push(thread)
          return thread
        }
      }

      return controller
    }

    // Try defineProperty
    try {
      Object.defineProperty(vscode.comments, 'createCommentController', {
        value: wrapped,
        writable: true,
        configurable: true,
      })
      log('[intercept] Patched via defineProperty')
      return
    } catch {
      // fall through
    }

    // Try direct assignment
    try {
      (vscode.comments as Record<string, unknown>).createCommentController = wrapped
      log('[intercept] Patched via assignment')
    } catch (err: unknown) {
      log('[intercept] Cannot patch: ' + (err instanceof Error ? err.message : String(err)))
    }
  } catch (err: unknown) {
    log('[intercept] Setup error: ' + (err instanceof Error ? err.message : String(err)))
  }
}

const reviewScopeCommands: Record<string, string> = {
  all: 'github.copilot.chat.review.changes',
  staged: 'github.copilot.chat.review.stagedChanges',
  unstaged: 'github.copilot.chat.review.unstagedChanges',
}

async function startCopilotReview(scope: string): Promise<{ started: boolean; error?: string }> {
  const command = reviewScopeCommands[scope] ?? reviewScopeCommands.all
  try {
    await vscode.commands.executeCommand(command)
    return { started: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    log('[startReview] Error executing ' + command + ': ' + message)
    return { started: false, error: message }
  }
}

async function waitForReviewComments(timeoutMs: number): Promise<ReviewComment[]> {
  const pollInterval = 2000
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const service = findReviewService()
    if (service) {
      const comments = extractComments(service)
      if (comments.length > 0) return comments
    }

    const intercepted = extractFromIntercepted()
    if (intercepted.length > 0) return intercepted

    await new Promise(resolve => setTimeout(resolve, pollInterval))
  }

  return []
}

class StartReviewTool implements vscode.LanguageModelTool<StartReviewInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<StartReviewInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const scope = options.input?.scope ?? 'all'
    const waitForComments = options.input?.waitForComments ?? true

    log('[startReview] Starting review with scope: ' + scope)
    const result = await startCopilotReview(scope)

    if (!result.started) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify({
          success: false,
          error: result.error ?? 'Failed to start review',
        })),
      ])
    }

    if (waitForComments) {
      log('[startReview] Waiting for review comments...')
      const comments = await waitForReviewComments(60000)
      cachedComments = comments
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify({
          success: true,
          scope,
          commentsFound: comments.length,
          comments: comments.length > 0 ? comments : undefined,
          message: comments.length > 0
            ? 'Review complete with ' + comments.length + ' comment(s)'
            : 'Review started but no comments appeared within timeout. The review may still be in progress — use #reviewComments to check later.',
        }, null, 2)),
      ])
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify({
        success: true,
        scope,
        message: 'Review started. Use #reviewComments to read the results once the review completes.',
      }, null, 2)),
    ])
  }
}

class ReviewCommentsTool implements vscode.LanguageModelTool<ToolInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ToolInput>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    debugLog.length = 0
    const source = options.input?.source ?? 'all'
    const allComments: ReviewComment[] = []

    // Local comments (Copilot review)
    if (source === 'local' || source === 'all') {
      log('[tool] Fetching local review comments...')
      const service = findReviewService()
      if (service) {
        const comments = extractComments(service)
        if (comments.length > 0) {
          allComments.push(...comments)
        } else {
          log('[tool] Found service but 0 comments')
        }
      }

      // File-based fallback
      const fileComments = await readCommentsFromFile()
      if (fileComments.length > 0) {
        allComments.push(...fileComments)
      }

      // Intercepted threads fallback
      if (interceptedThreads.length > 0) {
        const comments = extractFromIntercepted()
        allComments.push(...comments)
      }
    }

    // PR comments (GitHub)
    if (source === 'pr' || source === 'all') {
      log('[tool] Fetching PR comments via gh CLI...')
      try {
        const prComments = await fetchAllPrComments()
        allComments.push(...prComments)
      } catch (err: unknown) {
        log('[tool] PR comments error: ' + (err instanceof Error ? err.message : String(err)))
      }
    }

    if (allComments.length > 0) {
      cachedComments = allComments
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify(allComments, null, 2)),
      ])
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        'No review comments found.\n\n--- Debug log ---\n' + debugLog.join('\n')
      ),
    ])
  }
}

async function writeCommentsFile(comments: ReviewComment[]): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders
  if (!workspaceFolders?.length) return

  const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, '.review-comments.json')
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(comments, null, 2)))
}

export function activate(context: vscode.ExtensionContext) {
  setupInterceptor()

  context.subscriptions.push(
    vscode.lm.registerTool('review-reader_getReviewComments', new ReviewCommentsTool())
  )

  context.subscriptions.push(
    vscode.lm.registerTool('review-reader_startReview', new StartReviewTool())
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('review-reader.requestReview', async () => {
      const scopeOptions = ['All Changes', 'Staged Changes', 'Unstaged Changes']
      const picked = await vscode.window.showQuickPick(scopeOptions, {
        placeHolder: 'What should Copilot review?',
      })
      if (!picked) return

      const scopeMap: Record<string, string> = {
        'All Changes': 'all',
        'Staged Changes': 'staged',
        'Unstaged Changes': 'unstaged',
      }
      const scope = scopeMap[picked] ?? 'all'

      const result = await startCopilotReview(scope)
      if (result.started) {
        vscode.window.showInformationMessage('Copilot review started (' + scope + ' changes)')
      } else {
        vscode.window.showErrorMessage('Failed to start review: ' + (result.error ?? 'unknown error'))
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('review-reader.dumpComments', async () => {
      debugLog.length = 0
      const service = findReviewService()
      if (service) {
        const comments = extractComments(service)
        if (comments.length > 0) {
          await writeCommentsFile(comments)
          vscode.window.showInformationMessage(
            'Dumped ' + comments.length + ' review comment(s) to .review-comments.json'
          )
          return
        }
      }

      if (interceptedThreads.length > 0) {
        const comments = extractFromIntercepted()
        if (comments.length > 0) {
          await writeCommentsFile(comments)
          vscode.window.showInformationMessage(
            'Dumped ' + comments.length + ' intercepted comment(s)'
          )
          return
        }
      }

      vscode.window.showWarningMessage(
        'No review comments found. Run a Copilot review first.'
      )
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('review-reader.showComments', async () => {
      debugLog.length = 0
      const outputChannel = vscode.window.createOutputChannel('Review Comments')
      outputChannel.clear()

      outputChannel.appendLine('=== Finding review service ===')
      const service = findReviewService()

      if (service) {
        const comments = extractComments(service)
        outputChannel.appendLine('Found ' + comments.length + ' comments')
        for (const c of comments) {
          outputChannel.appendLine('')
          outputChannel.appendLine('[' + c.file + ':' + c.line + ']')
          outputChannel.appendLine(c.body)
          if (c.suggestion) {
            outputChannel.appendLine('  Suggestion: ' + c.suggestion.substring(0, 200))
          }
        }
      }

      outputChannel.appendLine('')
      outputChannel.appendLine('=== Intercepted threads: ' + interceptedThreads.length + ' ===')
      outputChannel.appendLine('')
      outputChannel.appendLine('=== Debug log ===')
      for (const line of debugLog) {
        outputChannel.appendLine(line)
      }

      outputChannel.show()
    })
  )
}

export function deactivate() {}
