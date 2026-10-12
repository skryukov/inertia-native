// `inertia-native run ios|android`: builds the native shell, picks or boots a
// simulator/emulator, installs and launches the app.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

import { devCommand, findProjectRoot } from './project.mjs'
import { createPrompter } from './prompt.mjs'

export const RUN_USAGE = `Usage: npx inertia-native run <ios|android> [options]

Builds the app in ios/ or android/, installs it on a simulator, emulator or
device and launches it. Start your dev server first.
On Android it runs \`adb reverse\` for the dev server's port (and Vite's), so
the device reaches localhost on this machine.

It uses the simulator or device that's running, or starts one: the newest
iPhone, or an Android emulator. When there's a choice, it asks in a
terminal and takes the first one elsewhere.

Options:
  --device <name>   iOS: simulator name or UDID. Android: serial from \`adb devices\`
  -h, --help        Show this help`

const exe = (/** @type {string} */ name, /** @type {NodeJS.Platform} */ os) => (os === 'win32' ? `${name}.exe` : name)

class Failure extends Error {}
/** @param {string} message @returns {never} */
const fail = (message) => {
  throw new Failure(message)
}

/** @typedef {import('./prompt.mjs').Prompter} Prompter */

/**
 * @typedef {import('./init.mjs').IO & { capture: Capture, spawn: Spawn }} RunIO
 * @typedef {(cmd: string, args: string[]) => { ok: boolean, stdout: string, stderr: string }} Capture
 *   Runs a command and returns its output.
 * @typedef {(cmd: string, args: string[], options?: { cwd?: string, env?: Record<string, string | undefined>, background?: boolean }) => Promise<number>} Spawn
 *   Runs a command with the terminal attached and resolves with its exit code;
 *   `background` detaches it without output (it doesn't keep the CLI running)
 *   and resolves when it exits.
 */

/**
 * @param {string[]} argv
 * @param {RunIO} io
 * @returns {Promise<number>}
 */
export async function run(argv, io) {
  const { cwd } = io
  const out = (/** @type {string} */ line) => io.stdout.write(`${line}\n`)
  const warn = (/** @type {string} */ line) => io.stderr.write(`${line}\n`)

  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        device: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (error) {
    warn(/** @type {Error} */ (error).message)
    warn('Run `npx inertia-native run --help` for usage.')
    return 1
  }
  const { values: flags, positionals } = parsed
  if (flags.help) {
    out(RUN_USAGE)
    return 0
  }
  const [platform, ...rest] = positionals
  if (rest.length || (platform !== 'ios' && platform !== 'android')) {
    warn(platform ? `Unknown platform "${positionals.join(' ')}": use ios or android.` : RUN_USAGE)
    return 1
  }

  // Asks only in a terminal, and closes before any build takes the terminal over.
  const prompter = io.prompter ?? (io.stdin.isTTY ? createPrompter(io.stdin, /** @type {NodeJS.WritableStream} */ (io.stdout)) : undefined)
  try {
    const root = findProjectRoot(cwd) ?? fail(`No package.json in ${cwd} or any parent directory. Run this from your app's root.`)
    const marker = platform === 'ios' ? join(root, 'ios', 'App.xcodeproj') : join(root, 'android', 'gradlew')
    if (!existsSync(marker)) fail(`No ${platform}/ shell in ${root}. Create it with: npx inertia-native init ${platform}`)

    const url = bakedUrl(root, platform)
    if (url && !(await responds(url))) {
      const dev = devCommand(root)
      warn(`! Nothing answers at ${url}: start your dev server first${dev ? ` (${dev})` : ''}. Building anyway.`)
    }

    if (platform === 'ios') await runIos(root, flags.device, prompter, io, out, warn)
    else await runAndroid(root, flags.device, url, prompter, io, out, warn)
    return 0
  } catch (error) {
    if (!(error instanceof Failure)) throw error
    warn(`✗ ${error.message}`)
    return 1
  } finally {
    prompter?.close()
  }
}

/**
 * @param {string} root
 * @param {string | undefined} device
 * @param {Prompter | undefined} prompter
 * @param {RunIO} io
 * @param {(line: string) => void} out
 * @param {(line: string) => void} warn
 */
async function runIos(root, device, prompter, io, out, warn) {
  const { capture } = io
  const developer = xcodeDeveloperDir(io)
  const sims = iosSimulators(listSimulators(io))
  const sim = await chooseSimulator(sims, { device, prompter })
  prompter?.close()
  out(`✓ Simulator: ${sim.name} (iOS ${sim.runtime})`)
  if (sim.state !== 'Booted') {
    const booted = capture('xcrun', ['simctl', 'boot', sim.udid])
    if (!booted.ok) fail(`Couldn't boot ${sim.name}: ${booted.stderr.trim()}`)
  }
  if (!showSimulator(developer, sim.udid, io)) {
    warn(`! Couldn't open Simulator, so ${sim.name} has no window. Open Simulator (Device Hub from Xcode 27) to see the app.`)
  }

  out('› xcodebuild (the first build downloads Swift packages and takes a few minutes)')
  const derived = join('ios', 'build')
  const status = await io.spawn(
    'xcodebuild',
    ['-project', join('ios', 'App.xcodeproj'), '-scheme', 'App', '-configuration', 'Debug',
      '-destination', `id=${sim.udid}`, '-derivedDataPath', derived, '-quiet', 'build'],
    { cwd: root, env: io.env },
  )
  if (status !== 0) fail('xcodebuild failed; see the errors above.')

  const app = join(root, derived, 'Build', 'Products', 'Debug-iphonesimulator', 'App.app')
  const bundleId = capture('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Info.plist')]).stdout.trim()
  capture('xcrun', ['simctl', 'bootstatus', sim.udid, '-b'])
  const installed = capture('xcrun', ['simctl', 'install', sim.udid, app])
  if (!installed.ok) fail(`Couldn't install on ${sim.name}: ${installed.stderr.trim()}`)
  const launched = capture('xcrun', ['simctl', 'launch', '--terminate-running-process', sim.udid, bundleId])
  if (!launched.ok) fail(`Couldn't launch ${bundleId}: ${launched.stderr.trim()}`)
  out(`✓ Launched ${bundleId} on ${sim.name}`)
}

/**
 * Opens the simulator's window: Simulator.app, or Device Hub, which replaces
 * it from Xcode 27 (in <Xcode>/Contents/Applications) and opens devices by
 * URL. The selected Xcode's app first: `open -a` may pick another Xcode's.
 * @param {string} developer the selected Xcode's Contents/Developer
 * @param {string} udid
 * @param {RunIO} io
 * @returns {boolean} whether one opened
 */
function showSimulator(developer, udid, io) {
  const simulator = join(developer, 'Applications', 'Simulator.app')
  const deviceHub = join(developer, '..', 'Applications', 'DeviceHub.app')
  const device = ['--args', '-CurrentDeviceUDID', udid]
  const url = `devices://device/open?id=${udid}`
  const attempts = existsSync(simulator)
    ? [[simulator, ...device]]
    : existsSync(deviceHub)
      ? [[url]]
      : [['-a', 'Simulator', ...device], [url]]
  return attempts.some((args) => io.capture('open', args).ok)
}

/**
 * The selected Xcode's Contents/Developer, after checking it's Xcode.
 * @param {RunIO} io
 */
function xcodeDeveloperDir({ os, capture }) {
  if (os !== 'darwin') fail('iOS apps build on macOS only (with Xcode).')
  const selected = capture('xcode-select', ['-p'])
  if (!selected.ok) fail("Xcode isn't installed. Install it from the App Store, open it once, then re-run this.")
  if (selected.stdout.includes('CommandLineTools')) {
    fail(
      'The Command Line Tools are selected instead of Xcode. Install Xcode from the App Store, then run:\n' +
        '  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
    )
  }
  return selected.stdout.trim()
}

/**
 * The parsed `xcrun simctl list devices available`.
 * @param {RunIO} io
 * @returns {SimctlList}
 */
function listSimulators({ capture }) {
  const list = capture('xcrun', ['simctl', 'list', 'devices', 'available', '--json'])
  if (!list.ok) fail(`Couldn't list simulators: ${list.stderr.trim()}\nOpen Xcode once so it can finish installing its components.`)
  return JSON.parse(list.stdout)
}

/**
 * The Android SDK's adb and emulator.
 * @param {Record<string, string | undefined>} env
 * @param {NodeJS.Platform} os
 */
function androidTools(env, os) {
  const sdk =
    findAndroidSdk(env, homedir(), os) ??
    fail('Android SDK not found. Install Android Studio and open it once (it downloads the SDK), or set ANDROID_HOME to your SDK.')
  const adb = join(sdk, 'platform-tools', exe('adb', os))
  if (!existsSync(adb)) {
    fail(`No adb in ${sdk}. In Android Studio: Settings > Languages & Frameworks > Android SDK > SDK Tools, install Android SDK Platform-Tools.`)
  }
  return { sdk, adb, emulator: join(sdk, 'emulator', exe('emulator', os)) }
}

/**
 * @param {string} root
 * @param {string | undefined} device
 * @param {string | undefined} url
 * @param {Prompter | undefined} prompter
 * @param {RunIO} io
 * @param {(line: string) => void} out
 * @param {(line: string) => void} warn
 */
async function runAndroid(root, device, url, prompter, io, out, warn) {
  const { env, os, capture } = io
  const { sdk, adb, emulator } = androidTools(env, os)
  const jdk =
    findJdk(env, io) ??
    fail('No Java found (Gradle needs JDK 17 or newer). Android Studio bundles one; or install a JDK (brew install openjdk@21) and set JAVA_HOME.')
  out(`✓ Android SDK: ${sdk}`)
  out(`✓ JDK: ${jdk.home ?? 'java on PATH'}`)

  /** @type {Record<string, string | undefined>} */
  const gradleEnv = { ...env, ANDROID_HOME: sdk }
  if (jdk.home) gradleEnv.JAVA_HOME = jdk.home
  const android = join(root, 'android')
  const gradlew = os === 'win32' ? 'gradlew.bat' : './gradlew'

  const target = await chooseAndroidTarget(androidDevices(adb, io), () => listAvds(emulator, io), { device, prompter })
  prompter?.close()
  /** @type {string | undefined} */
  let serial
  /** @type {Promise<string> | undefined} */
  let booting
  const stopBooting = new AbortController()
  if ('serial' in target) serial = target.serial
  else booting = startEmulator(emulator, adb, target.avd, io, out, stopBooting.signal)

  if (booting) {
    booting.catch(() => {}) // awaited below; don't crash if the build fails first
    // Build while the emulator boots.
    out(`› ${gradlew} assembleDebug (the first build downloads Gradle and dependencies)`)
    if ((await io.spawn(gradlew, ['assembleDebug'], { cwd: android, env: gradleEnv })) !== 0) {
      stopBooting.abort() // the emulator keeps booting, but the CLI exits
      fail('Gradle build failed; see the errors above.')
    }
    serial = await booting
  }
  out(`› ${gradlew} installDebug (${serial})`)
  if ((await io.spawn(gradlew, ['installDebug'], { cwd: android, env: { ...gradleEnv, ANDROID_SERIAL: serial } })) !== 0) {
    fail('Gradle build failed; see the errors above.')
  }

  // The device's localhost is the device; forward the dev server ports to this machine.
  const { ports, warning } = reversePorts(root, url)
  const forwarded = ports.filter((port) => capture(adb, ['-s', /** @type {string} */ (serial), 'reverse', `tcp:${port}`, `tcp:${port}`]).ok)
  if (forwarded.length) out(`✓ adb reverse ${forwarded.map((port) => `tcp:${port}`).join(', ')} (localhost on ${serial} reaches this machine)`)
  for (const port of ports.filter((port) => !forwarded.includes(port))) warn(`! Couldn't run adb reverse tcp:${port} tcp:${port}`)
  if (warning) warn(warning)

  const appId =
    readFileSync(join(android, 'app', 'build.gradle.kts'), 'utf8').match(/applicationId\s*=\s*"([^"]+)"/)?.[1] ??
    fail("Couldn't find applicationId in android/app/build.gradle.kts.")
  // Starts the app's launcher activity, whatever its class is called. Without
  // --pct-syskeys 0, monkey aborts on emulators, which have no system keys.
  const monkey = ['monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '--pct-syskeys', '0', '1']
  const started = capture(adb, ['-s', /** @type {string} */ (serial), 'shell', ...monkey])
  if (!started.ok || /aborted/.test(started.stdout)) {
    fail(`Couldn't launch ${appId}: ${(started.stdout + started.stderr).trim().split('\n').at(-1)}`)
  }
  out(`✓ Launched ${appId} on ${serial}`)
}

/**
 * Ports for `adb reverse`: the app's (when its URL is local) and the Vite dev
 * server's: the URL laravel-vite-plugin (public/hot) or rails-vite-plugin
 * (tmp/rails-vite.json) wrote, vite_ruby's port (config/vite.json), else
 * Vite's default 5173 for a dev server started later.
 * @param {string} root
 * @param {string | undefined} url
 * @returns {{ ports: number[], warning?: string }}
 */
export function reversePorts(root, url) {
  const ports = new Set()
  const local = (/** @type {URL | undefined} */ u) => u && ['localhost', '127.0.0.1'].includes(u.hostname)
  const port = (/** @type {URL} */ u) => Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  const app = parseUrl(url)
  if (app && local(app)) ports.add(port(app))

  let warning
  const vite = parseUrl(devServerUrl(root))
  const viteRuby = readJson(join(root, 'config', 'vite.json'))
  if (vite?.hostname === '[::1]') {
    warning =
      `! Vite puts ${vite.host} script URLs in the page, which Android can't load: the app will show "Error loading page".\n` +
      "  Add server: { hmr: { host: 'localhost' } } to your vite.config, restart the dev server and run this again."
  } else if (vite && local(vite)) {
    ports.add(port(vite))
  } else if (viteRuby) {
    ports.add(Number(viteRuby.development?.port ?? viteRuby.all?.port ?? 3036))
  } else if (readdirSync(root).some((file) => /^vite\.config\.[cm]?[jt]s$/.test(file))) {
    ports.add(5173)
  }
  return { ports: [...ports], warning }
}

/**
 * The running Vite dev server's URL, as written by the Laravel or Rails plugin.
 * @param {string} root
 */
function devServerUrl(root) {
  const hot = join(root, 'public', 'hot')
  if (existsSync(hot)) return readFileSync(hot, 'utf8').trim()
  const meta = readJson(join(root, 'tmp', 'rails-vite.json'))
  return typeof meta?.url === 'string' ? meta.url : undefined
}

/** @param {string} path @returns {any} */
function readJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
  } catch {
    return undefined
  }
}

/** @param {string | undefined} value */
function parseUrl(value) {
  try {
    return value ? new URL(value) : undefined
  } catch {
    return undefined
  }
}

/**
 * Starts an AVD and resolves with its serial once Android has booted.
 * @param {string} emulator
 * @param {string} adb
 * @param {string} avd
 * @param {RunIO} io
 * @param {(line: string) => void} out
 * @param {AbortSignal} signal stops waiting
 * @returns {Promise<string>}
 */
function startEmulator(emulator, adb, avd, io, out, signal) {
  out(`› Starting emulator ${avd}`)
  /** @type {string | undefined} */
  let exited
  io.spawn(emulator, ['-avd', avd], { background: true }).then((code) => (exited = `the emulator exited (code ${code})`))

  return (async () => {
    const deadline = Date.now() + 5 * 60_000
    /** @type {string | undefined} */
    let serial
    // The first check waits only for the caller to start the build.
    for (let wait = 0; Date.now() < deadline; wait = 2000) {
      await sleep(wait, undefined, { signal })
      if (exited) fail(`Couldn't start ${avd}: ${exited}. Try starting it from Android Studio's Device Manager.`)
      serial ??= adbDevices(adb, io, true).find((s) => s.startsWith('emulator-') && avdName(adb, s, io) === avd)
      if (serial && io.capture(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']).stdout.trim() === '1') {
        out(`✓ Emulator ${avd} booted (${serial})`)
        return serial
      }
    }
    return fail(`${avd} didn't finish booting in 5 minutes.`)
  })()
}

/**
 * Serials of connected devices (`all` includes offline ones).
 * @param {string} adb
 * @param {RunIO} io
 */
function adbDevices(adb, io, all = false) {
  return parseAdbDevices(io.capture(adb, ['devices']).stdout)
    .filter((d) => all || d.state === 'device')
    .map((d) => d.serial)
}

/**
 * @typedef {{ serial: string, state: string, model?: string, avd?: string }} AndroidDevice
 *   `state` is `device` when usable; `avd` is set for running emulators.
 */

/**
 * Everything `adb devices -l` lists, with the AVD name of each emulator.
 * @param {string} adb
 * @param {RunIO} io
 * @returns {AndroidDevice[]}
 */
function androidDevices(adb, io) {
  return parseAdbDevices(io.capture(adb, ['devices', '-l']).stdout).map((device) =>
    device.serial.startsWith('emulator-') && device.state === 'device' ? { ...device, avd: avdName(adb, device.serial, io) || undefined } : device,
  )
}

/**
 * Parses `adb devices` (or `adb devices -l`).
 * @param {string} text
 * @returns {AndroidDevice[]}
 */
export function parseAdbDevices(text) {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state)
    .map(([serial, state, ...details]) => {
      const model = details.find((detail) => detail.startsWith('model:'))?.slice(6).replaceAll('_', ' ')
      return model ? { serial, state, model } : { serial, state }
    })
}

/** @param {string} adb @param {string} serial @param {RunIO} io */
function avdName(adb, serial, io) {
  return io.capture(adb, ['-s', serial, 'emu', 'avd', 'name']).stdout.split(/\r?\n/)[0].trim()
}

/** @param {string} emulator @param {RunIO} io */
function listAvds(emulator, io) {
  return io.capture(emulator, ['-list-avds']).stdout.split(/\r?\n/).filter((line) => line && !line.startsWith('INFO'))
}

/**
 * What to run on: a connected device, else an emulator to start. Several
 * are asked about in a terminal; elsewhere the first is taken.
 * @param {AndroidDevice[]} devices
 * @param {() => string[]} avds AVD names, read only when needed
 * @param {{ device?: string, prompter?: Prompter }} options
 * @returns {Promise<{ serial: string } | { avd: string }>}
 */
export async function chooseAndroidTarget(devices, avds, { device, prompter }) {
  const ready = devices.filter((d) => d.state === 'device')
  if (device) {
    if (ready.some((d) => d.serial === device)) return { serial: device }
    return fail(`No device ${device} connected. Connected: ${ready.map((d) => d.serial).join(', ') || 'none'}`)
  }
  if (ready.length === 1 || (ready.length && !prompter)) return { serial: ready[0].serial }
  if (ready.length) {
    const label = (/** @type {AndroidDevice} */ d) => [d.serial, d.avd ?? d.model].filter(Boolean).join('  ')
    return { serial: (await pick(/** @type {Prompter} */ (prompter), 'Several devices are connected. Which one?', ready, label)).serial }
  }

  const names = avds()
  if (!names.length) fail('No device is connected and no emulator to start. In Android Studio: Device Manager > Create Virtual Device.')
  if (names.length === 1 || !prompter) return { avd: names[0] }
  return { avd: await prompter.select('No device is connected. Which emulator should start?', names, names[0]) }
}

/**
 * @typedef {{ devices: Record<string, Array<{ udid: string, name: string, state: string, isAvailable?: boolean, deviceTypeIdentifier?: string }>> }} SimctlList
 * @typedef {{ udid: string, name: string, state: string, runtime: string, iphone: boolean }} Simulator
 */

/**
 * Available iOS simulators from `xcrun simctl list devices available --json`,
 * newest iOS first.
 * @param {SimctlList} list
 * @returns {Simulator[]}
 */
export function iosSimulators(list) {
  return Object.entries(list.devices)
    .map(([runtime, devices]) => ({ version: runtime.match(/SimRuntime\.iOS-([\d-]+)$/)?.[1].split('-').map(Number), devices }))
    .filter((r) => r.version)
    .sort((a, b) => compareVersions(/** @type {number[]} */ (b.version), /** @type {number[]} */ (a.version)))
    .flatMap((r) =>
      r.devices
        .filter((d) => d.isAvailable !== false)
        .map(({ udid, name, state, deviceTypeIdentifier }) => ({
          udid,
          name,
          state,
          runtime: /** @type {number[]} */ (r.version).join('.'),
          // Simulators can be renamed; the device type says what they are.
          iphone: deviceTypeIdentifier ? deviceTypeIdentifier.includes('.iPhone') : name.startsWith('iPhone'),
        })),
    )
}

/**
 * The simulator to use: `device` (name or UDID), else the booted one, else an
 * iPhone to start. Several are asked about in a terminal; elsewhere the
 * first (newest) is taken.
 * @param {Simulator[]} sims from iosSimulators
 * @param {{ device?: string, prompter?: Prompter }} options
 * @returns {Promise<Simulator>}
 */
export async function chooseSimulator(sims, { device, prompter }) {
  if (device) {
    const named = sims.filter((s) => s.name === device)
    return (
      sims.find((s) => s.udid === device) ??
      named.find((s) => s.state === 'Booted') ??
      named[0] ??
      fail(`No simulator "${device}". Simulators: ${[...new Set(sims.map((s) => s.name))].join(', ')}`)
    )
  }
  const booted = sims.filter((s) => s.state === 'Booted')
  if (booted.length === 1 || (booted.length && !prompter)) return booted[0]
  if (booted.length) return pick(/** @type {Prompter} */ (prompter), 'Several simulators are booted. Which one?', booted, simulatorLabel(booted))
  const iphones = sims.filter((s) => s.iphone)
  if (!iphones.length) fail('No iPhone simulator found. In Xcode: Settings > Components, install an iOS simulator.')
  return prompter ? pick(prompter, 'Which simulator should start?', iphones, simulatorLabel(iphones)) : iphones[0]
}

/**
 * `iPhone 17 (iOS 26.5)`, with the UDID when that's ambiguous.
 * @param {Simulator[]} sims
 */
function simulatorLabel(sims) {
  const short = (/** @type {Simulator} */ sim) => `${sim.name} (iOS ${sim.runtime})`
  return (/** @type {Simulator} */ sim) =>
    sims.filter((other) => short(other) === short(sim)).length > 1 ? `${sim.name} (iOS ${sim.runtime}, ${sim.udid})` : short(sim)
}

/**
 * Asks to pick one of `items`, by label; the first is the default.
 * @template T
 * @param {Prompter} prompter
 * @param {string} question
 * @param {T[]} items
 * @param {(item: T) => string} label
 * @returns {Promise<T>}
 */
async function pick(prompter, question, items, label) {
  const labels = items.map(label)
  return items[labels.indexOf(await prompter.select(question, labels, labels[0]))]
}

/** @param {number[]} a @param {number[]} b */
function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  }
  return 0
}

/**
 * The URL a generated shell loads.
 * @param {string} root
 * @param {'ios' | 'android'} platform
 */
export function bakedUrl(root, platform) {
  const [file, pattern] =
    platform === 'ios'
      ? [join(root, 'ios', 'App', 'AppConfig.swift'), /URL\(string:\s*"([^"]+)"\)/]
      : [join(root, 'android', 'app', 'build.gradle.kts'), /"BASE_URL",\s*"\\"([^"\\]+)\\""/]
  return existsSync(file) ? readFileSync(file, 'utf8').match(pattern)?.[1] : undefined
}

/** @param {string} url */
async function responds(url) {
  try {
    await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
    return true
  } catch {
    return false
  }
}

/**
 * The Android SDK: ANDROID_HOME, else where Android Studio puts it.
 * @param {Record<string, string | undefined>} env
 * @param {string} [home]
 * @param {NodeJS.Platform} [os]
 */
export function findAndroidSdk(env, home = homedir(), os = process.platform) {
  const fallback = {
    darwin: join(home, 'Library', 'Android', 'sdk'),
    linux: join(home, 'Android', 'Sdk'),
    win32: env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Android', 'Sdk'),
  }[/** @type {'darwin' | 'linux' | 'win32'} */ (os)]
  return [env.ANDROID_HOME, fallback].find((dir) => dir && existsSync(dir) && statSync(dir).isDirectory())
}

/**
 * A JDK for Gradle: JAVA_HOME, Android Studio's bundled one, else `java` on
 * PATH.
 * @param {Record<string, string | undefined>} env
 * @param {RunIO} io
 * @returns {{ home?: string } | undefined}
 */
export function findJdk(env, { os, capture }) {
  const java = (/** @type {string} */ home) => existsSync(join(home, 'bin', exe('java', os)))
  if (env.JAVA_HOME && java(env.JAVA_HOME)) return { home: env.JAVA_HOME }
  const studio = {
    darwin: '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    linux: '/opt/android-studio/jbr',
    win32: 'C:\\Program Files\\Android\\Android Studio\\jbr',
  }[/** @type {'darwin' | 'linux' | 'win32'} */ (os)]
  if (studio && java(studio)) return { home: studio }
  return capture('java', ['-version']).ok ? {} : undefined
}
