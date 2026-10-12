import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { main } from '../bin/cli.mjs'
import {
  bakedUrl,
  chooseAndroidTarget,
  chooseSimulator,
  findAndroidSdk,
  findJdk,
  iosSimulators,
  parseAdbDevices,
  reversePorts,
} from '../bin/run.mjs'

let tmp
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'inertia-native-run-'))
  writeFileSync(join(tmp, 'package.json'), '{}')
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** Runs the CLI; starting any process fails the test. */
async function cli(args) {
  let stdout = ''
  let stderr = ''
  const unexpected = (cmd, args) => {
    throw new Error(`Unexpected command: ${[cmd, ...args].join(' ')}`)
  }
  const code = await main(args, {
    cwd: tmp,
    env: {},
    os: 'darwin',
    stdin: /** @type {any} */ ({ isTTY: false }),
    stdout: { write: (s) => (stdout += s) },
    stderr: { write: (s) => (stderr += s) },
    exec: () => 0,
    capture: unexpected,
    spawn: unexpected,
  })
  return { code, stdout, stderr }
}

/** A file in tmp. */
function file(path, content = '') {
  mkdirSync(join(tmp, path, '..'), { recursive: true })
  writeFileSync(join(tmp, path), content)
  return join(tmp, path)
}

const sim = (name, udid, state = 'Shutdown') => ({ name, udid, state })

/** Scripted picker: records each question and answers with `answer(choices)` (default: the default). */
function fakePrompter(answer = (choices, fallback) => fallback) {
  const asked = []
  return {
    asked,
    async select(label, choices, fallback) {
      asked.push({ label, choices, fallback })
      return answer(choices, fallback)
    },
    async text() {
      throw new Error('unexpected text prompt')
    },
    async confirm() {
      throw new Error('unexpected confirm prompt')
    },
    close() {},
  }
}

const runtimes = {
  'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [sim('iPhone 16', 'old-16'), sim('iPad Air', 'old-ipad')],
  'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [sim('iPad Pro', 'new-ipad'), sim('iPhone 17 Pro', 'new-17p'), sim('iPhone 17', 'new-17')],
  'com.apple.CoreSimulator.SimRuntime.iOS-26-10': [],
  'com.apple.CoreSimulator.SimRuntime.watchOS-26-0': [sim('Apple Watch', 'watch')],
}
/** iosSimulators of `runtimes`, with the given UDIDs booted. */
const sims = (...booted) => {
  const list = structuredClone({ devices: runtimes })
  for (const devices of Object.values(list.devices)) for (const d of devices) if (booted.includes(d.udid)) d.state = 'Booted'
  return iosSimulators(list)
}

describe('iosSimulators', () => {
  it('lists available iOS simulators, newest runtime first', () => {
    expect(sims().map((s) => `${s.udid} ${s.runtime}`)).toEqual(['new-ipad 26.5', 'new-17p 26.5', 'new-17 26.5', 'old-16 18.2', 'old-ipad 18.2'])
  })
})

describe('chooseSimulator', () => {
  it('takes --device by UDID or by name', async () => {
    expect((await chooseSimulator(sims(), { device: 'old-16' })).udid).toBe('old-16')
    expect((await chooseSimulator(sims(), { device: 'iPad Air' })).udid).toBe('old-ipad')
    await expect(chooseSimulator(sims(), { device: 'iPhone 99' })).rejects.toThrow('No simulator "iPhone 99". Simulators: iPad Pro, iPhone 17 Pro, iPhone 17, iPhone 16, iPad Air')
  })

  it('uses the one booted simulator, iPad or not, without asking', async () => {
    const prompter = fakePrompter()
    expect((await chooseSimulator(sims('old-ipad'), { prompter })).udid).toBe('old-ipad')
    expect((await chooseSimulator(sims('old-16'), {})).udid).toBe('old-16')
    expect(prompter.asked).toEqual([])
  })

  it('asks which of several booted simulators in a terminal', async () => {
    const prompter = fakePrompter((choices) => choices[1])
    expect((await chooseSimulator(sims('old-16', 'new-17'), { prompter })).udid).toBe('old-16')
    expect(prompter.asked).toEqual([
      { label: 'Several simulators are booted. Which one?', choices: ['iPhone 17 (iOS 26.5)', 'iPhone 16 (iOS 18.2)'], fallback: 'iPhone 17 (iOS 26.5)' },
    ])
  })

  it('takes the newest of several booted without a terminal', async () => {
    expect((await chooseSimulator(sims('old-16', 'new-17'), {})).udid).toBe('new-17')
  })

  it('asks which iPhone to start in a terminal when none is booted, newest first', async () => {
    const prompter = fakePrompter()
    expect((await chooseSimulator(sims(), { prompter })).udid).toBe('new-17p')
    expect(prompter.asked).toEqual([
      {
        label: 'Which simulator should start?',
        choices: ['iPhone 17 Pro (iOS 26.5)', 'iPhone 17 (iOS 26.5)', 'iPhone 16 (iOS 18.2)'],
        fallback: 'iPhone 17 Pro (iOS 26.5)',
      },
    ])
  })

  it('takes the newest iPhone without a terminal when none is booted', async () => {
    expect((await chooseSimulator(sims(), {})).udid).toBe('new-17p')
  })



  it('fails without any iPhone', async () => {
    const ipads = iosSimulators({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [sim('iPad', 'y')] } })
    await expect(chooseSimulator(ipads, { prompter: fakePrompter() })).rejects.toThrow('No iPhone simulator found.')
  })
})

it('parses adb devices, with models from adb devices -l', () => {
  const text = 'List of devices attached\nemulator-5554\tdevice\nR58M\tunauthorized\nemulator-5556\toffline\n\n'
  expect(parseAdbDevices(text)).toEqual([
    { serial: 'emulator-5554', state: 'device' },
    { serial: 'R58M', state: 'unauthorized' },
    { serial: 'emulator-5556', state: 'offline' },
  ])
  const long = 'List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n' +
    '1A2B3C                 device usb:1-1 product:panther model:Pixel_7 device:panther transport_id:2\n'
  expect(parseAdbDevices(long)).toEqual([
    { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 arm64' },
    { serial: '1A2B3C', state: 'device', model: 'Pixel 7' },
  ])
})

describe('chooseAndroidTarget', () => {
  const emu = (serial, avd) => ({ serial, state: 'device', avd })
  const phone = { serial: '1A2B3C', state: 'device', model: 'Pixel 7' }
  const unauthorized = { serial: 'R58M', state: 'unauthorized' }
  const noAvds = () => {
    throw new Error('AVDs read without need')
  }

  it('uses the one connected device without asking or reading AVDs', async () => {
    const prompter = fakePrompter()
    expect(await chooseAndroidTarget([emu('emulator-5554', 'pixel'), unauthorized], noAvds, { prompter })).toEqual({ serial: 'emulator-5554' })
    expect(await chooseAndroidTarget([phone], noAvds, {})).toEqual({ serial: '1A2B3C' })
    expect(prompter.asked).toEqual([])
  })

  it('asks which of several connected devices in a terminal', async () => {
    const prompter = fakePrompter((choices) => choices[1])
    expect(await chooseAndroidTarget([emu('emulator-5554', 'pixel'), phone, unauthorized], noAvds, { prompter })).toEqual({ serial: '1A2B3C' })
    expect(prompter.asked).toEqual([
      { label: 'Several devices are connected. Which one?', choices: ['emulator-5554  pixel', '1A2B3C  Pixel 7'], fallback: 'emulator-5554  pixel' },
    ])
  })

  it('takes the first of several devices without a terminal', async () => {
    expect(await chooseAndroidTarget([emu('emulator-5554', 'pixel'), phone], noAvds, {})).toEqual({ serial: 'emulator-5554' })
  })

  it('starts the only AVD when nothing is connected, without asking', async () => {
    const prompter = fakePrompter()
    expect(await chooseAndroidTarget([unauthorized], () => ['pixel'], { prompter })).toEqual({ avd: 'pixel' })
    expect(await chooseAndroidTarget([], () => ['pixel'], {})).toEqual({ avd: 'pixel' })
    expect(prompter.asked).toEqual([])
  })

  it('asks which of several AVDs to start in a terminal', async () => {
    const prompter = fakePrompter()
    expect(await chooseAndroidTarget([], () => ['pixel', 'tablet'], { prompter })).toEqual({ avd: 'pixel' })
    expect(prompter.asked).toEqual([{ label: 'No device is connected. Which emulator should start?', choices: ['pixel', 'tablet'], fallback: 'pixel' }])
  })

  it('starts the first AVD without a terminal', async () => {
    expect(await chooseAndroidTarget([], () => ['pixel', 'tablet'], {})).toEqual({ avd: 'pixel' })
  })

  it('fails when there is nothing to run on', async () => {
    await expect(chooseAndroidTarget([unauthorized], () => [], { prompter: fakePrompter() })).rejects.toThrow(
      'No device is connected and no emulator to start. In Android Studio: Device Manager > Create Virtual Device.',
    )
  })

  it('takes --device among connected devices', async () => {
    const devices = [emu('emulator-5554', 'pixel'), phone, unauthorized]
    expect(await chooseAndroidTarget(devices, noAvds, { device: '1A2B3C' })).toEqual({ serial: '1A2B3C' })
    await expect(chooseAndroidTarget(devices, noAvds, { device: 'R58M' })).rejects.toThrow('No device R58M connected. Connected: emulator-5554, 1A2B3C')
  })

})

it('reads the URL baked into generated shells', async () => {
  await cli(['init', '--skip-install', '--url', 'http://localhost:4567/app'])
  expect(bakedUrl(tmp, 'ios')).toBe('http://localhost:4567/app')
  expect(bakedUrl(tmp, 'android')).toBe('http://localhost:4567/app')
})

describe('reversePorts', () => {
  it('forwards a local app URL port, defaulting to 80/443', () => {
    expect(reversePorts(tmp, 'http://localhost:3000')).toEqual({ ports: [3000], warning: undefined })
    expect(reversePorts(tmp, 'http://127.0.0.1')).toEqual({ ports: [80], warning: undefined })
    expect(reversePorts(tmp, 'https://localhost/app')).toEqual({ ports: [443], warning: undefined })
  })

  it('leaves remote and 10.0.2.2 URLs alone', () => {
    expect(reversePorts(tmp, 'https://acme.dev').ports).toEqual([])
    expect(reversePorts(tmp, 'http://10.0.2.2:8000').ports).toEqual([])
    expect(reversePorts(tmp, undefined).ports).toEqual([])
  })

  it("adds Laravel's Vite port: from public/hot, else Vite's default with a vite.config", () => {
    expect(reversePorts(tmp, 'http://localhost:8000').ports).toEqual([8000])
    file('vite.config.ts')
    expect(reversePorts(tmp, 'http://localhost:8000').ports).toEqual([8000, 5173])
    file('public/hot', 'http://127.0.0.1:5174')
    expect(reversePorts(tmp, 'http://localhost:8000').ports).toEqual([8000, 5174])
    file('public/hot', 'http://localhost:5175\n')
    expect(reversePorts(tmp, 'http://localhost:8000').ports).toEqual([8000, 5175])
  })

  it("adds rails-vite-plugin's port from tmp/rails-vite.json", () => {
    file('tmp/rails-vite.json', JSON.stringify({ url: 'http://127.0.0.1:5180', sourceDir: 'app/javascript' }))
    expect(reversePorts(tmp, 'http://localhost:3000').ports).toEqual([3000, 5180])
  })

  it.each([
    ['public/hot', 'http://[::1]:5173'],
    ['tmp/rails-vite.json', JSON.stringify({ url: 'http://[::1]:5173' })],
  ])('explains the fix when Vite puts [::1] URLs in the page (%s)', (path, content) => {
    file('vite.config.ts')
    file(path, content)
    const { ports, warning } = reversePorts(tmp, 'http://localhost:8000')
    expect(ports).toEqual([8000])
    expect(warning).toContain('Vite puts [::1]:5173 script URLs in the page')
    expect(warning).toContain("server: { hmr: { host: 'localhost' } }")
  })

  it("adds vite_ruby's dev server port (HMR)", () => {
    file('config/vite.json', JSON.stringify({ all: { port: 3036 }, development: { port: 3037 } }))
    expect(reversePorts(tmp, 'http://localhost:3000').ports).toEqual([3000, 3037])
    file('config/vite.json', JSON.stringify({ all: {} }))
    expect(reversePorts(tmp, 'http://localhost:3000').ports).toEqual([3000, 3036])
    file('config/vite.json', '{ nope')
    expect(reversePorts(tmp, 'http://localhost:3000').ports).toEqual([3000])
    file('vite.config.mts')
    expect(reversePorts(tmp, 'http://localhost:3000').ports).toEqual([3000, 5173])
  })
})

describe('findAndroidSdk', () => {
  it('prefers ANDROID_HOME, then the default location', () => {
    const home = join(tmp, 'home')
    const fallback = join(home, 'Library', 'Android', 'sdk')
    const sdk = join(tmp, 'sdk')
    for (const dir of [fallback, sdk]) mkdirSync(dir, { recursive: true })
    expect(findAndroidSdk({ ANDROID_HOME: sdk }, home, 'darwin')).toBe(sdk)
    expect(findAndroidSdk({ ANDROID_HOME: join(tmp, 'missing') }, home, 'darwin')).toBe(fallback)
    expect(findAndroidSdk({}, home, 'linux')).toBeUndefined()
  })
})

it('uses JAVA_HOME when it has bin/java', () => {
  mkdirSync(join(tmp, 'jdk', 'bin'), { recursive: true })
  writeFileSync(join(tmp, 'jdk', 'bin', 'java'), '')
  expect(findJdk({ JAVA_HOME: join(tmp, 'jdk') }, { os: 'linux' })).toEqual({ home: join(tmp, 'jdk') })
})

describe('run errors', () => {
  it('needs a platform', async () => {
    const { code, stderr } = await cli(['run'])
    expect(code).toBe(1)
    expect(stderr).toContain('Usage: npx inertia-native run <ios|android>')
  })

  it('rejects unknown platforms', async () => {
    const { code, stderr } = await cli(['run', 'web'])
    expect(code).toBe(1)
    expect(stderr).toContain('Unknown platform "web": use ios or android.')
  })

  it.each(['ios', 'android'])('says how to create a missing %s shell', async (platform) => {
    const { code, stderr } = await cli(['run', platform])
    expect(code).toBe(1)
    expect(stderr).toContain(`✗ No ${platform}/ shell in ${tmp}. Create it with: npx inertia-native init ${platform}`)
  })

  it('prints help', async () => {
    const { code, stdout } = await cli(['run', '--help'])
    expect(code).toBe(0)
    expect(stdout).toContain('--device <name>')
  })
})
