// options.js — 选项页：让用户把 dsh 侧的桥 token 填一次（外加一个高级项：桥地址）
const $token = document.getElementById('token')
const $status = document.getElementById('status')
const $save = document.getElementById('save')
const $clear = document.getElementById('clear')
const $bridgeUrl = document.getElementById('bridgeUrl')
const $saveUrl = document.getElementById('saveUrl')

const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:31820'

function setStatus(text, kind) {
  $status.textContent = text
  $status.className = kind || ''
}

function looksLikeToken(v) {
  return /^[0-9a-f]{16,128}$/i.test(v.trim())
}
function looksLikeUrl(v) {
  return /^wss?:\/\/[^\s/]+(:\d+)?(\/.*)?$/i.test(v.trim())
}

chrome.storage.local.get({ bridgeToken: '', bridgeUrl: DEFAULT_BRIDGE_URL }).then(({ bridgeToken, bridgeUrl }) => {
  $token.value = bridgeToken
  $bridgeUrl.value = bridgeUrl || DEFAULT_BRIDGE_URL
  if (!bridgeToken) {
    setStatus('还没配置 token —— 桥不会接受这个扩展的连接。', 'bad')
  } else {
    setStatus(`已配置（${bridgeToken.slice(0, 6)}…）。去 turbowarp.org/editor 试连接。`, 'ok')
  }
})

$save.addEventListener('click', async () => {
  const v = $token.value.trim()
  if (!looksLikeToken(v)) {
    setStatus('格式不对：应该是 16 位以上的十六进制字符（0-9 a-f）。', 'bad')
    return
  }
  await chrome.storage.local.set({ bridgeToken: v })
  setStatus('已保存。开着的 TurboWarp 页面会自动重连，不用刷新。', 'ok')
})

$clear.addEventListener('click', async () => {
  await chrome.storage.local.set({ bridgeToken: '' })
  $token.value = ''
  setStatus('已清空。桥会拒绝连接。', 'bad')
})

$saveUrl.addEventListener('click', async () => {
  const v = $bridgeUrl.value.trim() || DEFAULT_BRIDGE_URL
  if (!looksLikeUrl(v)) {
    setStatus('桥地址格式不对，应该形如 ws://127.0.0.1:31820', 'bad')
    return
  }
  await chrome.storage.local.set({ bridgeUrl: v })
  setStatus(`桥地址已改为 ${v}（几秒内自动重连）。`, 'ok')
})
