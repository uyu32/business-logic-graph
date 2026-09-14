import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

function escapeInlineScript(source) {
  return source.replaceAll('</script', '<\\/script')
}

function escapeInlineStyle(source) {
  return source.replaceAll('</style', '<\\/style')
}

export async function renderStandaloneViewer({ graph, viewerDist, outputPath }) {
  const dist = path.resolve(viewerDist)
  let html = await readFile(path.join(dist, 'index.html'), 'utf8')
  const stylesheet = html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/)
  const moduleScript = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)
  if (!stylesheet || !moduleScript) throw new Error('Viewer build does not contain the expected CSS and module assets')

  const assetPath = (url) => path.join(dist, url.replace(/^\.?\//, ''))
  const css = escapeInlineStyle(await readFile(assetPath(stylesheet[1]), 'utf8'))
  const javascript = escapeInlineScript(await readFile(assetPath(moduleScript[1]), 'utf8'))
  const graphJson = JSON.stringify(graph).replaceAll('<', '\\u003c')
  const favicon = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Crect width=%2264%22 height=%2264%22 rx=%2214%22 fill=%22%23111827%22/%3E%3Cpath d=%22M22 16c-6 0-8 4-8 10v3c0 3-2 5-5 5 3 0 5 2 5 5v3c0 6 2 10 8 10M42 16c6 0 8 4 8 10v3c0 3 2 5 5 5-3 0-5 2-5 5v3c0 6-2 10-8 10%22 fill=%22none%22 stroke=%22%23f59e0b%22 stroke-width=%224%22 stroke-linecap=%22round%22/%3E%3C/svg%3E'

  html = html.replace(stylesheet[0], () => `<style>${css}</style>`)
  html = html.replace(
    moduleScript[0],
    () => `<script>window.__BLG_GRAPH__=${graphJson};</script><script type="module">${javascript}</script>`,
  )
  html = html.replace(/<link rel="icon"[^>]*>/, () => `<link rel="icon" type="image/svg+xml" href="${favicon}">`)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, html, 'utf8')
  return { outputPath: path.resolve(outputPath), bytes: Buffer.byteLength(html) }
}
