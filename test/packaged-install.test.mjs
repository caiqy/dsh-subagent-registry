// Release regression: npm and strict pnpm must install without approving builds.
// The SDK linker remains an explicit development command, not an install hook.
// Run: node test/packaged-install.test.mjs  (after `npm run build`)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
// Windows needs cmd.exe to launch npm's .cmd shim; keep paths as separate arguments.
const npm = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm'
const npmArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd'] : []

if (!existsSync(join(repoRoot, 'lib', 'index.js'))) {
  throw new Error('lib/index.js missing — run `npm run build` before the test chain')
}

const scratch = mkdtempSync(join(tmpdir(), 'registry packaged install-'))
try {
  // 1. Pack from the repo the way CI's release job does.
  const packed = JSON.parse(
    execFileSync(npm, [...npmArgs, 'pack', '--json', '--pack-destination', scratch], {
      cwd: repoRoot,
      encoding: 'utf8',
    }),
  )[0]
  const tarball = join(scratch, packed.filename)

  // 2. Development utility ships, but its repository-only guard markers do not.
  const contents = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split(/\r?\n/)
  assert.ok(
    contents.includes('package/scripts/link-dsh-closure.mjs'),
    'explicit development linker is in the tarball',
  )
  assert.ok(!contents.some((f) => f.startsWith('package/tsconfig.json')), 'tsconfig.json never ships (linker guard marker)')
  assert.ok(!contents.some((f) => f.includes('/.git')), '.git never ships (linker guard marker)')

  // 3. The reporter's exact failing step: a plain npm install of the tarball,
  //    postinstall included. Must exit 0 — MODULE_NOT_FOUND here is #2 again.
  const consumer = join(scratch, 'consumer')
  execFileSync(npm, [...npmArgs, 'install', tarball, '--prefix', consumer, '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: scratch,
    encoding: 'utf8',
    // A failed guard must reach realpathSync and fail, even on machines without dsh.
    env: { ...process.env, DSH_CLOSURE_DIR: join(scratch, 'missing-closure') },
  })
  const installed = join(consumer, 'node_modules', '@caiqy', 'dsh-subagent-registry')
  assert.ok(existsSync(join(installed, 'scripts', 'link-dsh-closure.mjs')), 'installed package carries the hook target')
  const metadata = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  // 4. Use the same strict pnpm generation as Desktop, with no build approvals.
  const pnpmConsumer = join(scratch, 'pnpm-consumer')
  mkdirSync(pnpmConsumer)
  writeFileSync(join(pnpmConsumer, 'package.json'), '{"private":true}\n')
  writeFileSync(join(pnpmConsumer, 'pnpm-workspace.yaml'), 'packages: [.]\nautoInstallPeers: false\nstrictDepBuilds: true\nallowBuilds: {}\n')
  execFileSync(npm, [...npmArgs, 'exec', '--yes', '--package=pnpm@11.28.5', '--', 'pnpm', 'add', tarball], {
    cwd: pnpmConsumer,
    encoding: 'utf8',
  })
  const pnpmInstalled = join(pnpmConsumer, 'node_modules', '@caiqy', 'dsh-subagent-registry')
  assert.equal(JSON.parse(readFileSync(join(pnpmInstalled, 'package.json'), 'utf8')).version, metadata.version)
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(metadata.scripts?.[hook], undefined, `published package must not have ${hook}`)
  }
  assert.equal(metadata.name, '@caiqy/dsh-subagent-registry')
  assert.ok(readFileSync(join(installed, 'cordis.patch.yml'), 'utf8').includes(`name: '${metadata.name}'`), 'bundle imports the installed personal package')
  assert.ok(readFileSync(join(installed, 'cordis.patch.yml'), 'utf8').includes('id: dsh-subagent-registry'), 'stable Cordis id is retained')
  assert.ok(readFileSync(join(installed, 'lib', 'client.js'), 'utf8').includes(`id:"${metadata.name}"`), 'client loader registers the installed package name')

  // 5. Consumer safety: no @deepseek-ai
  //    scope dir materialized inside the consumer's package tree.
  assert.ok(
    !existsSync(join(installed, 'node_modules', '@deepseek-ai')),
    'linker did not touch the consumer tree (guard markers held)',
  )
  assert.ok(
    !existsSync(join(consumer, 'node_modules', '@deepseek-ai')),
    'optional host SDK peers did not install a consumer-side copy',
  )
  console.log('packaged-install: npm and strict pnpm install without build approvals or consumer SDK copies')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
