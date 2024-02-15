const HypercoreID = require('hypercore-id-encoding')
const Verifier = require('hypercore/lib/verifier')
const caps = require('hypercore/lib/caps')
const m = require('hypercore/lib/messages')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')

const [BLOBS] = crypto.namespace('hyperdrive', 1)

const VERSION = 1

const Request = {
  preencode (state, req) {
    c.uint.preencode(state, req.version)
    c.uint.preencode(state, req.length)
    c.uint.preencode(state, req.fork)
    c.fixed32.preencode(state, req.treeHash)
    m.manifest.preencode(state, req.manifest)
    c.uint8.preencode(state, 0)
    if (req.blobs === null) return
    c.uint.preencode(state, req.blobs.lengt)
    c.fixed32.preencode(state, req.blobs.treeHash)
  },
  encode (state, req) {
    c.uint.encode(state, req.version)
    c.uint.encode(state, req.length)
    c.uint.encode(state, req.fork)
    c.fixed32.encode(state, req.treeHash)
    m.manifest.encode(state, req.manifest)
    c.uint.encode(state, req.blobs ? 1 : 0)
    if (req.blobs === null) return
    c.uint.encode(state, req.blobs.lengt)
    c.fixed32.encode(state, req.blobs.treeHash)
  },
  decode (state) {
    const version = c.uint.decode(state)
    if (version !== VERSION) throw new Error('Unknown signing request version: ' + version)

    const length = c.uint.decode(state)
    const fork = c.uint.decode(state)
    const treeHash = c.fixed32.decode(state)
    const manifest = m.manifest.decode(state)

    const key = Verifier.manifestHash(manifest)
    const id = HypercoreID.normalize(key)

    const isDrive = state.start !== state.end && c.uint8.decode(state) !== 0
    const blobs = !isDrive
      ? null
      : {
          length: c.uint.decode(state),
          treeHash: c.fixed32.decode(state)
        }

    return {
      version,
      id,
      key,
      length,
      fork,
      treeHash,
      manifest,
      isDrive,
      blobs
    }
  }
}

module.exports = {
  generate,
  generateDrive,
  decode,
  signable,
  blobSignable
}

async function generate (core, { length = core.length, fork = core.fork, manifest = null } = {}) {
  if (!core.opened) await core.ready()

  if (core.blobs) return generateDrive(core, { length, fork, manifest })

  if (core.core.compat && !manifest) throw new Error('Cannot generate signing requests for compat cores')
  if (core.fork !== fork) throw new Error('Core should have the same fork')
  if (!manifest) manifest = core.manifest

  return c.encode(Request, {
    version: VERSION,
    length,
    fork,
    treeHash: await core.treeHash(length),
    manifest,
    blobs: null
  })
}

async function generateDrive (drive, { length = drive.core.length, fork = drive.core.fork, manifest = null }) {
  if (drive.core.core.compat && !manifest) throw new Error('Cannot generate signing requests for compat cores')

  if (!manifest) manifest = drive.core.manifest

  const last = await drive.db.getBySeq(length - 1)
  const { blockOffset, blockLength } = last.value

  const blobs = { length: blockOffset + blockLength }

  blobs.treeHash = await drive.blobs.core.treeHash(blobs.length)

  return c.encode(Request, {
    version: VERSION,
    length,
    fork,
    treeHash: await drive.core.treeHash(length),
    manifest,
    blobs
  })
}

function decode (buffer) {
  const state = { start: 0, end: buffer.byteLength, buffer }
  const req = Request.decode(state)

  if (req.length === 0) throw new Error('Refusing to sign length = 0')
  if (state.start < state.end) throw new Error('Unparsed padding left in request, bailing')

  return req
}

function signable (pub, req) {
  const v = req.manifest.version
  for (const s of req.manifest.signers) {
    if (s.publicKey.equals(pub)) {
      return caps.treeSignable(v === 0 ? s.namespace : req.key, req.treeHash, req.length, req.fork)
    }
  }

  throw new Error('Public key is not a declared signer for this request')
}

function blobSignable (pub, req) {
  if (!req.isDrive) throw new Error('Request does not specify a drive')

  const m = req.manifest
  if (m.version < 1) {
    throw new Error('Drive must use v1 manifests')
  }

  for (const s of m.signers) {
    if (s.publicKey.equals(pub)) {
      const namespace = crypto.hash([BLOBS, req.key, s.namespace])
      return caps.treeSignable(namespace, req.treeHash, req.length, req.fork)
    }
  }

  throw new Error('Public key is not a declared signer for this request')
}
