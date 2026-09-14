import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
])

export function injectLiveReload(html) {
  const script = `<script data-blg-live-reload>
(() => {
  const source = new EventSource('/__blg/events');
  source.addEventListener('reload', () => location.reload());
  source.addEventListener('build-error', (event) => {
    let overlay = document.querySelector('[data-blg-build-error]');
    if (!overlay) {
      overlay = document.createElement('pre');
      overlay.dataset.blgBuildError = '';
      Object.assign(overlay.style, {
        position: 'fixed', inset: '16px', zIndex: '2147483647', overflow: 'auto',
        margin: '0', padding: '20px', borderRadius: '12px', color: '#fecaca',
        background: 'rgba(69, 10, 10, .97)', boxShadow: '0 20px 60px rgba(0,0,0,.4)',
        font: '13px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace', whiteSpace: 'pre-wrap'
      });
      document.body.appendChild(overlay);
    }
    const payload = JSON.parse(event.data);
    overlay.textContent = 'BLG preview rebuild failed\\n\\n' + payload.message;
  });
})();
</script>`
  return html.includes('</body>') ? html.replace('</body>', `${script}</body>`) : `${html}${script}`
}

function resolveRequestPath(root, requestUrl, entryPath) {
  const pathname = new URL(requestUrl, 'http://localhost').pathname
  const requested = pathname === '/' || pathname === '/viewer/index.html' ? `/${entryPath}` : pathname
  const relative = decodeURIComponent(requested).replace(/^\/+/, '')
  const absolute = path.resolve(root, relative)
  const boundary = path.relative(root, absolute)
  if (boundary.startsWith('..') || path.isAbsolute(boundary)) return null
  return absolute
}

export async function createPreviewServer({ root, host = '127.0.0.1', port = 5182, entryPath = 'viewer/index.html', metadata = {} }) {
  const absoluteRoot = path.resolve(root)
  const clients = new Set()
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      if (pathname === '/__blg/status') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(metadata))
        return
      }
      if (pathname === '/__blg/events') {
        response.writeHead(200, {
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream',
        })
        response.write(': connected\n\n')
        clients.add(response)
        request.on('close', () => clients.delete(response))
        return
      }

      const filePath = resolveRequestPath(absoluteRoot, request.url ?? '/', entryPath)
      if (!filePath) {
        response.writeHead(403).end('Forbidden')
        return
      }
      const info = await stat(filePath)
      if (!info.isFile()) {
        response.writeHead(404).end('Not found')
        return
      }
      const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream'
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Type', contentType)
      if (path.basename(filePath) === 'index.html') {
        response.end(injectLiveReload(await readFile(filePath, 'utf8')))
      } else {
        createReadStream(filePath).pipe(response)
      }
    } catch (error) {
      const status = error?.code === 'ENOENT' ? 404 : 500
      response.writeHead(status).end(status === 404 ? 'Not found' : 'Preview server error')
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port

  return {
    url: `http://${host}:${actualPort}/viewer/index.html`,
    broadcast(event, payload = {}) {
      const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
      for (const client of clients) client.write(message)
    },
    async close() {
      for (const client of clients) client.end()
      clients.clear()
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}
