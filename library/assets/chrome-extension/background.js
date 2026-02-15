const DEFAULT_PORT = 18792
const DEFAULT_AUTO_ATTACH_MODE = 'always'
const MANUAL_DETACH_COOLDOWN_MS = 15_000

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null
/** @type {number|null} */
let reconnectTimer = null
let reconnectAttempt = 0
let manualDetachCooldownUntil = 0

let debuggerListenersInstalled = false

let nextSession = 1

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

function classifyAttachError(message) {
  const lower = String(message || '').toLowerCase()
  if (
    lower.includes('cannot attach') ||
    lower.includes('permission') ||
    lower.includes('not allowed') ||
    lower.includes('requires user gesture') ||
    lower.includes('debugger')
  ) {
    return 'permission'
  }
  if (
    lower.includes('chrome://') ||
    lower.includes('edge://') ||
    lower.includes('devtools://') ||
    lower.includes('chrome web store')
  ) {
    return 'blocked_url'
  }
  if (lower.includes('already attached') || lower.includes('another debugger')) {
    return 'debugger_in_use'
  }
  return 'attach_failed'
}

async function getRelayPort() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const raw = stored.relayPort
  const n = Number.parseInt(String(raw || ''), 10)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

async function getAutoAttachMode() {
  const stored = await chrome.storage.local.get(['autoAttachMode'])
  if (stored.autoAttachMode === 'always') return 'always'
  if (stored.autoAttachMode === 'manual') return 'manual'
  return DEFAULT_AUTO_ATTACH_MODE
}

async function ensureAutoAttachDefault() {
  const stored = await chrome.storage.local.get(['autoAttachMode'])
  if (stored.autoAttachMode === 'manual' || stored.autoAttachMode === 'always') {
    return
  }
  await chrome.storage.local.set({ autoAttachMode: DEFAULT_AUTO_ATTACH_MODE })
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const port = await getRelayPort()
    const httpBase = `http://127.0.0.1:${port}`
    const wsUrl = `ws://127.0.0.1:${port}/extension?takeover=1`

    // Fast preflight: is the relay server up?
    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`)
    }

    const ws = new WebSocket(wsUrl)
    relayWs = ws

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))
    ws.onclose = () => onRelayClosed('closed')
    ws.onerror = () => onRelayClosed('error')

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true
      chrome.debugger.onEvent.addListener(onDebuggerEvent)
      chrome.debugger.onDetach.addListener(onDebuggerDetach)
    }
  })()

  try {
    await relayConnectPromise
    reconnectAttempt = 0
  } catch (err) {
    // Avoid stale socket references after failed handshakes and keep reconnect alive.
    relayWs = null
    scheduleReconnectLoop()
    throw err
  } finally {
    relayConnectPromise = null
  }
}

async function maybeAutoAttachActiveTab(opts = {}) {
  const mode = await getAutoAttachMode()
  if (mode !== 'always') {
    return
  }
  if (Date.now() < manualDetachCooldownUntil) {
    return
  }
  try {
    await connectOrToggleForActiveTab({ forceAttach: true, manual: false, ...opts })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('auto-attach failed', message, nowStack())
  }
}

function scheduleReconnectLoop() {
  if (reconnectTimer) {
    return
  }
  const delay = Math.min(10_000, 500 * Math.pow(2, reconnectAttempt))
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    reconnectAttempt += 1
    try {
      await ensureRelayConnection()
      reconnectAttempt = 0
      await maybeAutoAttachActiveTab({ forceAttach: true })
    } catch {
      scheduleReconnectLoop()
    }
  }, delay)
}

function onRelayClosed(reason) {
  const hadTabs = tabs.size > 0
  relayWs = null
  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  for (const tabId of tabs.keys()) {
    void chrome.debugger.detach({ tabId }).catch(() => {})
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: disconnected (click to re-attach)',
    })
  }
  tabs.clear()
  tabBySession.clear()
  childSessionToTab.clear()

  void (async () => {
    const mode = await getAutoAttachMode()
    if (hadTabs || mode === 'always') {
      scheduleReconnectLoop()
    }
  })()
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  ws.send(JSON.stringify(payload))
}

async function maybeOpenHelpOnce() {
  try {
    const stored = await chrome.storage.local.get(['helpOnErrorShown'])
    if (stored.helpOnErrorShown === true) return
    await chrome.storage.local.set({ helpOnErrorShown: true })
    await chrome.runtime.openOptionsPage()
  } catch {
    // ignore
  }
}

function requestFromRelay(command) {
  const id = command.id
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      sendToRelay(command)
    } catch (err) {
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

async function onRelayMessage(text) {
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg && msg.method === 'ping') {
    try {
      sendToRelay({ method: 'pong' })
    } catch {
      // ignore
    }
    return
  }

  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  return null
}

function parseAttachableUrl(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const parsed = new URL(text)
    if (
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'https:' &&
      parsed.protocol !== 'chrome-extension:' &&
      parsed.protocol !== 'about:'
    ) {
      return null
    }
    if (parsed.protocol === 'about:' && parsed.pathname !== 'blank') return null
    return parsed
  } catch {
    return null
  }
}

function scoreTabUrlMatch(tab, wanted) {
  const parsed = parseAttachableUrl(tab?.url)
  if (!parsed) return -1

  if (parsed.protocol !== wanted.protocol) {
    return -1
  }

  let score = 0
  if (wanted.protocol === 'chrome-extension:') {
    if (parsed.hostname.toLowerCase() !== wanted.hostname.toLowerCase()) {
      return -1
    }
    score += 100
    const wantedPath = wanted.pathname || '/'
    if (wantedPath !== '/' && parsed.pathname.startsWith(wantedPath)) {
      score += 20
    }
  } else if (wanted.protocol === 'about:') {
    if (parsed.href !== wanted.href) {
      return -1
    }
    score += 100
  } else {
    const wantedHost = wanted.hostname.toLowerCase()
    const tabHost = parsed.hostname.toLowerCase()
    if (tabHost === wantedHost) {
      score += 100
    } else if (tabHost.endsWith(`.${wantedHost}`) || wantedHost.endsWith(`.${tabHost}`)) {
      score += 80
    } else {
      return -1
    }

    const wantedPath = wanted.pathname || '/'
    if (wantedPath !== '/' && parsed.pathname.startsWith(wantedPath)) {
      score += 20
    }
  }
  if (tab.active) {
    score += 10
  }
  if (tab.highlighted) {
    score += 5
  }
  if (tabs.get(tab.id)?.state === 'connected') {
    score += 15
  }
  return score
}

async function findBestTabForUrl(url) {
  const wanted = parseAttachableUrl(url)
  if (!wanted) return null
  const allTabs = await chrome.tabs.query({})
  let best = null
  let bestScore = -1
  for (const tab of allTabs) {
    if (!tab?.id) continue
    const score = scoreTabUrlMatch(tab, wanted)
    if (score > bestScore) {
      bestScore = score
      best = tab
    }
  }
  return bestScore >= 0 ? best : null
}

async function attachSpecificTab(tabId) {
  const existing = tabs.get(tabId)
  if (existing?.state === 'connected') {
    return { ok: true, targetId: existing.targetId }
  }

  tabs.set(tabId, { state: 'connecting' })
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: connecting to local relay…',
  })

  try {
    await ensureRelayConnection()
    const attached = await attachTab(tabId)
    return { ok: true, targetId: attached?.targetId }
  } catch (err) {
    tabs.delete(tabId)
    setBadge(tabId, 'error')
    const message = err instanceof Error ? err.message : String(err)
    console.warn('attach failed', message, nowStack())
    return {
      ok: false,
      error: message || 'attach failed',
      errorCode: classifyAttachError(message),
    }
  }
}

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId }
  await chrome.debugger.attach(debuggee, '1.3')
  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {})

  const info = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'))
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) {
    throw new Error('Target.getTargetInfo returned no targetId')
  }

  const sessionId = `cb-tab-${nextSession++}`
  const attachOrder = nextSession

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
  tabBySession.set(sessionId, tabId)
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: attached (click to detach)',
  })

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    })
  }

  setBadge(tabId, 'on')
  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch {
      // ignore
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // ignore
  }

  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay (click to attach/detach)',
  })
}

async function connectOrToggleForActiveTab(opts = {}) {
  const forceAttach = opts.forceAttach === true
  const manual = opts.manual !== false
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  if (!tabId) return

  const existing = tabs.get(tabId)
  if (existing?.state === 'connected') {
    if (forceAttach) {
      return { ok: true, targetId: existing.targetId }
    }
    await detachTab(tabId, 'toggle')
    if (manual) {
      manualDetachCooldownUntil = Date.now() + MANUAL_DETACH_COOLDOWN_MS
    }
    return
  }

  tabs.set(tabId, { state: 'connecting' })
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: connecting to local relay…',
  })

  try {
    await ensureRelayConnection()
    await attachTab(tabId)
    const attached = tabs.get(tabId)
    return { ok: true, targetId: attached?.targetId }
  } catch (err) {
    tabs.delete(tabId)
    setBadge(tabId, 'error')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: relay not running (open options for setup)',
    })
    void maybeOpenHelpOnce()
    // Extra breadcrumbs in chrome://extensions service worker logs.
    const message = err instanceof Error ? err.message : String(err)
    console.warn('attach failed', message, nowStack())
    throw err
  }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  if (method === 'OpenClaw.attachActiveTab') {
    let attachError = ''
    const result = await connectOrToggleForActiveTab({ forceAttach: true, manual: false }).catch(
      (err) => {
        attachError = err instanceof Error ? err.message : String(err)
        return { ok: false }
      },
    )
    const targetId = typeof result?.targetId === 'string' ? result.targetId : undefined
    return {
      ok: result?.ok !== false,
      targetId,
      attachedTabCount: tabs.size,
      ...(result?.ok === false
        ? {
            error: attachError || 'attach failed',
            errorCode: classifyAttachError(attachError),
          }
        : {}),
    }
  }

  if (method === 'OpenClaw.attachTabByUrl') {
    const wantedUrl = String(params?.url || '').trim()
    if (!wantedUrl) {
      return { ok: false, error: 'url required', errorCode: 'invalid_request' }
    }

    const matched = await findBestTabForUrl(wantedUrl).catch(() => null)
    if (matched?.id) {
      const attached = await attachSpecificTab(matched.id)
      return {
        ...attached,
        targetId: attached?.targetId,
        matchedUrl: String(matched.url || ''),
        attachedTabCount: tabs.size,
      }
    }

    const parsed = parseAttachableUrl(wantedUrl)
    if (!parsed) {
      return { ok: false, error: 'invalid url', errorCode: 'invalid_url' }
    }

    const created = await chrome.tabs.create({ url: parsed.toString(), active: false }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      return { error: message }
    })
    if (!created || !created.id) {
      const message =
        created && typeof created.error === 'string' && created.error
          ? created.error
          : 'failed to create tab'
      return { ok: false, error: message, errorCode: classifyAttachError(message) }
    }
    const attached = await attachSpecificTab(created.id)
    return {
      ...attached,
      targetId: attached?.targetId,
      matchedUrl: parsed.toString(),
      attachedTabCount: tabs.size,
      createdTab: true,
    }
  }

  // Map command to tab
  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      // No sessionId: pick the first connected tab (stable-ish).
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') return id
      }
      return null
    })()

  if (!tabId) throw new Error(`No attached tab for method ${method}`)

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await new Promise((r) => setTimeout(r, 100))
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    try {
      await chrome.tabs.remove(toClose)
    } catch {
      return { success: false }
    }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee

  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch {
    // ignore
  }
}

function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return
  void detachTab(tabId, reason)
}

chrome.action.onClicked.addListener(() => {
  void connectOrToggleForActiveTab({ manual: true }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('manual toggle failed', message, nowStack())
  })
})

chrome.tabs.onActivated.addListener(() => {
  void maybeAutoAttachActiveTab({ forceAttach: true }).catch(() => {})
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  void maybeAutoAttachActiveTab({ forceAttach: true }).catch(() => {})
})

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab?.active) return
  void maybeAutoAttachActiveTab({ forceAttach: true }).catch(() => {})
})

void ensureAutoAttachDefault().catch(() => {})

chrome.runtime.onStartup.addListener(() => {
  void ensureAutoAttachDefault()
    .then(() => maybeAutoAttachActiveTab({ forceAttach: true }))
    .catch(() => {})
})

chrome.runtime.onInstalled.addListener(() => {
  void ensureAutoAttachDefault().catch(() => {})
  // Useful: first-time instructions.
  void chrome.runtime.openOptionsPage()
  void maybeAutoAttachActiveTab({ forceAttach: true }).catch(() => {})
})
