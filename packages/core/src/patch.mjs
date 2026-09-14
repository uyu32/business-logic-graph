import { isDeepStrictEqual } from 'node:util'
import { validateGraph } from './validate.mjs'

const FORBIDDEN_TOKENS = new Set(['__proto__', 'prototype', 'constructor'])

function clone(value) {
  return structuredClone(value)
}

function tokens(pointer) {
  if (pointer === '') return []
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new Error(`Invalid JSON pointer: ${pointer}`)
  return pointer.slice(1).split('/').map((part) => {
    const token = part.replace(/~1/g, '/').replace(/~0/g, '~')
    if (FORBIDDEN_TOKENS.has(token)) throw new Error(`Unsafe JSON pointer token: ${token}`)
    return token
  })
}

function resolveParent(doc, pointer) {
  const parts = tokens(pointer)
  if (parts.length === 0) return { parent: null, key: null }
  let parent = doc
  for (const token of parts.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object' || !(token in parent)) throw new Error(`Path does not exist: ${pointer}`)
    parent = parent[token]
  }
  return { parent, key: parts.at(-1) }
}

function getValue(doc, pointer) {
  let value = doc
  for (const token of tokens(pointer)) {
    if (value === null || typeof value !== 'object' || !(token in value)) throw new Error(`Path does not exist: ${pointer}`)
    value = value[token]
  }
  return value
}

function addValue(doc, pointer, value) {
  const { parent, key } = resolveParent(doc, pointer)
  if (parent === null) return clone(value)
  if (Array.isArray(parent)) {
    if (key === '-') parent.push(clone(value))
    else {
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0 || index > parent.length) throw new Error(`Invalid array index: ${pointer}`)
      parent.splice(index, 0, clone(value))
    }
  } else {
    if (parent === null || typeof parent !== 'object') throw new Error(`Parent is not a container: ${pointer}`)
    parent[key] = clone(value)
  }
  return doc
}

function removeValue(doc, pointer) {
  const { parent, key } = resolveParent(doc, pointer)
  if (parent === null) throw new Error('Removing the graph root is not supported')
  if (Array.isArray(parent)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error(`Invalid array index: ${pointer}`)
    parent.splice(index, 1)
  } else {
    if (parent === null || typeof parent !== 'object' || !(key in parent)) throw new Error(`Path does not exist: ${pointer}`)
    delete parent[key]
  }
  return doc
}

function replaceValue(doc, pointer, value) {
  if (pointer === '') return clone(value)
  getValue(doc, pointer)
  const { parent, key } = resolveParent(doc, pointer)
  parent[key] = clone(value)
  return doc
}

function assertMutable(graph, pointer) {
  const parts = tokens(pointer)
  if (parts.length === 0) throw new Error('Mutating the graph root is not supported')
  if (parts[0] === 'graphRevision' || parts[0] === 'updatedAt') throw new Error(`${pointer} is managed by the patch transaction`)
  if (parts[0] === 'claims') {
    if (!parts[1] && Object.values(graph.claims).some((claim) => claim.locked)) {
      throw new Error('The claims map contains a claim locked by a user correction')
    }
    if (parts[1] && graph.claims[parts[1]]?.locked) {
      throw new Error(`Claim ${parts[1]} is locked by a user correction`)
    }
  }
  if (parts[0] === 'nodes') {
    if (!parts[1] && Object.values(graph.nodes).some((node) => (node.locks ?? []).length > 0)) {
      throw new Error('The nodes map contains fields locked by a user correction')
    }
    const locks = parts[1] ? graph.nodes[parts[1]]?.locks ?? [] : []
    if (locks.length > 0 && (!parts[2] || locks.includes(parts[2]))) {
      throw new Error(`${parts[2] ? `Field ${parts[2]} on node` : 'Node'} ${parts[1]} is locked by a user correction`)
    }
  }
}

function applyOperation(doc, operation, lockSource) {
  if (!operation || typeof operation !== 'object') throw new Error('Patch operation must be an object')
  assertMutable(lockSource, operation.path)
  if (operation.from) assertMutable(lockSource, operation.from)
  switch (operation.op) {
    case 'add': return addValue(doc, operation.path, operation.value)
    case 'remove': return removeValue(doc, operation.path)
    case 'replace': return replaceValue(doc, operation.path, operation.value)
    case 'test':
      if (!isDeepStrictEqual(getValue(doc, operation.path), operation.value)) throw new Error(`Test operation failed at ${operation.path}`)
      return doc
    case 'copy': return addValue(doc, operation.path, getValue(doc, operation.from))
    case 'move': {
      const value = clone(getValue(doc, operation.from))
      doc = removeValue(doc, operation.from)
      return addValue(doc, operation.path, value)
    }
    default: throw new Error(`Unsupported patch operation: ${operation.op}`)
  }
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') throw new Error('Patch envelope must be an object')
  if (envelope.schemaVersion !== '0.1.0') throw new Error('Patch schemaVersion must equal 0.1.0')
  if (!Number.isInteger(envelope.baseGraphRevision)) throw new Error('baseGraphRevision must be an integer')
  if (typeof envelope.repositoryHead !== 'string' || envelope.repositoryHead.length === 0) throw new Error('repositoryHead is required')
  if (typeof envelope.reason !== 'string' || envelope.reason.length === 0) throw new Error('reason is required')
  if (!Array.isArray(envelope.operations) || envelope.operations.length === 0) throw new Error('operations must be a non-empty array')
}

export function applyPatchEnvelope(graph, envelope, options = {}) {
  validateEnvelope(envelope)
  const initialValidation = validateGraph(graph)
  if (!initialValidation.valid) throw new Error(`Cannot patch invalid graph: ${initialValidation.errors[0].path} ${initialValidation.errors[0].message}`)
  if (envelope.baseGraphRevision !== graph.graphRevision) {
    throw new Error(`Stale graph revision: expected ${graph.graphRevision}, received ${envelope.baseGraphRevision}`)
  }
  const currentHead = options.currentHead ?? graph.repository.head
  if (envelope.repositoryHead !== graph.repository.head || envelope.repositoryHead !== currentHead) {
    throw new Error(`Repository head mismatch: graph=${graph.repository.head}, patch=${envelope.repositoryHead}, current=${currentHead}`)
  }

  const lockSource = clone(graph)
  let next = clone(graph)
  for (const operation of envelope.operations) next = applyOperation(next, operation, lockSource)
  next.graphRevision = graph.graphRevision + 1
  next.updatedAt = options.now ?? new Date().toISOString()

  const result = validateGraph(next)
  if (!result.valid) throw new Error(`Patched graph is invalid: ${result.errors[0].path} ${result.errors[0].message}`)
  const post = envelope.postconditions ?? {}
  if (post.expectedGraphRevision !== undefined && post.expectedGraphRevision !== next.graphRevision) {
    throw new Error(`Postcondition failed: expected graph revision ${post.expectedGraphRevision}, received ${next.graphRevision}`)
  }
  for (const [claimId, status] of Object.entries(post.requiredClaimStatuses ?? {})) {
    if (next.claims[claimId]?.verification?.status !== status) {
      throw new Error(`Postcondition failed: claim ${claimId} is not ${status}`)
    }
  }
  return { graph: next, validation: result, appliedOperations: envelope.operations.length }
}
