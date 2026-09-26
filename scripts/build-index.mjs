#!/usr/bin/env node
/**
 * Generate index.json for this repository.
 *
 * index.json is the machine readable source of truth for the docs site and for
 * LINK (the web app). It maps every supported keyboard (keyed by VID:PID) to its
 * latest firmware package, keeps the release history and carries size/sha256 so
 * a package can be verified before it is flashed.
 *
 * Usage:
 *   node scripts/build-index.mjs           # (re)write index.json
 *   node scripts/build-index.mjs --check   # exit 1 when index.json is out of date
 *
 * Conventions:
 *   - a package name carries the firmware release: <prefix>_<YYMM>.zip
 *   - <prefix> is mapped to a keyboard in models.json
 *   - the release date is the last commit that touched the package; packages
 *     whose content did not change keep the date recorded in the previous
 *     index.json, so a shallow clone cannot shift dates around
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_FILE = join(ROOT, 'index.json')
const MODELS_FILE = join(ROOT, 'models.json')
const PACKAGE_RE = /^(?<prefix>.+)_(?<yymm>\d{4})\.zip$/
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')

function fail(message) {
    console.error(`\n[build-index] ${message}\n`)
    process.exit(1)
}

function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
        fail(`cannot read ${file}: ${error.message}`)
    }
}

function normalizeId(value, label) {
    const hex = String(value).toLowerCase().replace(/^0x/, '')

    if (!/^[0-9a-f]{1,4}$/.test(hex)) {
        fail(`"${value}" is not a valid ${label} in models.json`)
    }

    return `0x${hex.padStart(4, '0')}`
}

function parseRelease(yymm, file) {
    const year = yymm.slice(0, 2)
    const month = yymm.slice(2)

    if (!/^(0[1-9]|1[0-2])$/.test(month)) {
        fail(`${file}: "${yymm}" is not a valid YYMM release suffix`)
    }

    return {
        // the firmware reports the version as 0xYYMM, e.g. 0x2609 => 2026.09
        version: parseInt(yymm, 16),
        release: `20${year}.${month}`
    }
}

function sha256(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function assertZip(file) {
    const head = readFileSync(file).subarray(0, ZIP_MAGIC.length)

    if (!head.equals(ZIP_MAGIC)) {
        fail(`${file} is not a zip archive`)
    }
}

function lastCommitDate(file) {
    try {
        const date = execFileSync(
            'git',
            ['log', '-1', '--format=%ad', '--date=short', '--', file],
            { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim().split('\n')[0]

        if (date) return date
    } catch {
        // git is not available
    }

    return ''
}

function publishDate(file, digest, known) {
    const previous = known.get(file)

    // unchanged content: keep the date we already published
    if (previous?.sha256 === digest && previous.date) {
        return { date: previous.date, source: 'unchanged' }
    }

    const date = lastCommitDate(file)

    if (date) return { date, source: 'git' }

    return { date: statSync(join(ROOT, file)).mtime.toISOString().slice(0, 10), source: 'mtime' }
}

function knownDatesFromIndex() {
    const known = new Map()

    try {
        const index = JSON.parse(readFileSync(INDEX_FILE, 'utf8'))

        for (const model of Object.values(index.models || {})) {
            for (const item of model.history || []) {
                if (item?.file && item?.date) {
                    known.set(item.file, { date: item.date, sha256: item.sha256 })
                }
            }
        }
    } catch {
        // no usable previous index
    }

    return known
}

function main() {
    const config = readJson(MODELS_FILE)
    const baseUrl = config.baseUrl || ''
    const knownDates = knownDatesFromIndex()

    const models = new Map()

    for (const model of config.models || []) {
        const id = `${normalizeId(model.vid, 'vendor id')}:${normalizeId(model.pid, 'product id')}`

        if (models.has(id)) fail(`duplicate VID:PID ${id} in models.json`)

        models.set(id, { ...model, id, packages: [] })
    }

    const byPrefix = new Map()

    for (const model of models.values()) {
        if (model.prefix) byPrefix.set(model.prefix, model)
    }

    const unknown = []
    const dates = new Map()

    for (const file of readdirSync(ROOT).filter(name => name.endsWith('.zip')).sort()) {
        const match = PACKAGE_RE.exec(file)

        if (!match) fail(`${file}: expected <prefix>_<YYMM>.zip`)

        const model = byPrefix.get(match.groups.prefix)

        if (!model) {
            unknown.push(`${file} (prefix "${match.groups.prefix}")`)
            continue
        }

        assertZip(join(ROOT, file))

        const { version, release } = parseRelease(match.groups.yymm, file)
        const digest = sha256(join(ROOT, file))
        const { date, source } = publishDate(file, digest, knownDates)

        dates.set(file, source)
        model.packages.push({
            release,
            version,
            date,
            file,
            size: statSync(join(ROOT, file)).size,
            sha256: digest,
            url: `${baseUrl}${file}`
        })
    }

    if (unknown.length) {
        fail(`no model registered for:\n  - ${unknown.join('\n  - ')}\nadd the package prefix to models.json`)
    }

    const payload = {
        schema: config.schema || 1,
        baseUrl,
        source: config.source || '',
        models: {}
    }

    for (const model of [...models.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        const history = model.packages.sort((a, b) => b.version - a.version)

        payload.models[model.id] = {
            name: model.name,
            ...(model.half ? { half: model.half } : {}),
            latest: history[0] || null,
            history
        }
    }

    const output = `${JSON.stringify(payload, null, 2)}\n`
    const current = (() => {
        try {
            return readFileSync(INDEX_FILE, 'utf8')
        } catch {
            return null
        }
    })()

    const packages = [...models.values()].reduce((total, model) => total + model.packages.length, 0)
    const withPackages = [...models.values()].filter(model => model.packages.length).length

    console.log(`[build-index] ${packages} package(s), ${withPackages}/${models.size} model(s) with a package`)

    for (const model of [...models.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        const latest = model.packages[0]
        const name = `${model.name}${model.half ? ` (${model.half})` : ''}`

        console.log(`  ${model.id}  ${name.padEnd(24)} ${latest ? `${latest.release}  ${latest.file}` : 'no package yet'}`)
    }

    if (checkOnly) {
        if (current !== output) {
            fail('index.json is out of date, run: node scripts/build-index.mjs')
        }

        console.log('[build-index] index.json is up to date')
        return
    }

    if (current === output) {
        console.log('[build-index] index.json already up to date')
        return
    }

    writeFileSync(INDEX_FILE, output)

    for (const [file, source] of dates) {
        if (source === 'mtime') console.log(`  note: release date of ${file} came from the file system`)
    }

    console.log(`[build-index] wrote ${INDEX_FILE}`)
}

main()
