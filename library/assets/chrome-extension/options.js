const DEFAULT_PORT = 18792
const DEFAULT_AUTO_ATTACH_MODE = 'always'

function clampPort(value) {
  const n = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_PORT
  if (n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

function updateRelayUrl(port) {
  const el = document.getElementById('relay-url')
  if (!el) return
  el.textContent = `http://127.0.0.1:${port}/`
}

function setStatus(kind, message) {
  const status = document.getElementById('status')
  if (!status) return
  status.dataset.kind = kind || ''
  status.textContent = message || ''
}

async function checkRelayReachable(port) {
  const url = `http://127.0.0.1:${port}/`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 900)
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    setStatus('ok', `Relay reachable at ${url}`)
  } catch {
    setStatus(
      'error',
      `Relay not reachable at ${url}. Start OpenClaw’s browser relay on this machine, then click the toolbar button again.`,
    )
  } finally {
    clearTimeout(t)
  }
}

async function load() {
  const stored = await chrome.storage.local.get(['relayPort', 'autoAttachMode'])
  const port = clampPort(stored.relayPort)
  const autoAttachMode =
    stored.autoAttachMode === 'always'
      ? 'always'
      : stored.autoAttachMode === 'manual'
        ? 'manual'
        : DEFAULT_AUTO_ATTACH_MODE
  document.getElementById('port').value = String(port)
  const modeSelect = document.getElementById('auto-attach-mode')
  if (modeSelect) {
    modeSelect.value = autoAttachMode
  }
  updateRelayUrl(port)
  await checkRelayReachable(port)
}

async function save() {
  const input = document.getElementById('port')
  const modeSelect = document.getElementById('auto-attach-mode')
  const port = clampPort(input.value)
  const autoAttachMode = modeSelect?.value === 'manual' ? 'manual' : 'always'
  await chrome.storage.local.set({ relayPort: port, autoAttachMode })
  input.value = String(port)
  if (modeSelect) {
    modeSelect.value = autoAttachMode
  }
  updateRelayUrl(port)
  await checkRelayReachable(port)
  setStatus('ok', `Saved settings (mode: ${autoAttachMode}).`)
}

document.getElementById('save').addEventListener('click', () => void save())
void load()
