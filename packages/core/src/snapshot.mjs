import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.business-logic', '.sites-runtime', 'node_modules', 'dist', 'build',
  'release', 'coverage', '.next', '.output', 'vendor',
])

const LOGIC_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.gradle', '.h', '.hpp', '.html',
  '.java', '.js', '.jsx', '.json', '.kt', '.kts', '.md', '.mjs', '.cjs', '.php',
  '.properties', '.proto', '.py', '.rb', '.rs', '.sh', '.sql', '.swift', '.toml',
  '.ts', '.tsx', '.vue', '.xml', '.yaml', '.yml',
])

function shouldInclude(fileName) {
  if (fileName === '.env.example' || fileName === 'Dockerfile' || fileName === 'Makefile') return true
  if (fileName === '.env' || fileName.startsWith('.env.')) return false
  return LOGIC_EXTENSIONS.has(path.extname(fileName).toLowerCase())
}

async function collect(root, current = root, result = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) await collect(root, path.join(current, entry.name), result)
      continue
    }
    if (!entry.isFile() || !shouldInclude(entry.name)) continue
    const absolute = path.join(current, entry.name)
    const info = await stat(absolute)
    if (info.size > 8 * 1024 * 1024) continue
    result.push(path.relative(root, absolute).replaceAll('\\', '/'))
  }
  return result
}

export async function computeRepositorySnapshot(repositoryRoot) {
  const root = path.resolve(repositoryRoot)
  const files = (await collect(root)).sort((left, right) => left.localeCompare(right))
  const hash = createHash('sha256')
  for (const relativePath of files) {
    hash.update(relativePath)
    hash.update('\0')
    hash.update(await readFile(path.join(root, relativePath)))
    hash.update('\0')
  }
  const digest = hash.digest('hex')
  return {
    kind: 'snapshot',
    revision: `snapshot-sha256:${digest}`,
    digest,
    fileCount: files.length,
  }
}
