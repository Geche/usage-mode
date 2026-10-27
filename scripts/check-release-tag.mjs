#!/usr/bin/env node
// Checks that a release tag agrees with the manifest before anything is published.
//
// The tag shape is the one `claude plugin tag` creates: <name>--v<version>.
// Run from the mod's folder, with the tag as the argument or in GITHUB_REF_NAME.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const folder = process.argv[3] ?? process.cwd()
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME

const read = name => JSON.parse(readFileSync(join(folder, '.claude-plugin', name), 'utf8'))

const fail = (...lines) => {
  for (const line of lines) console.error(line)
  process.exit(1)
}

if (!tag) fail('No tag given: pass it as the first argument, or set GITHUB_REF_NAME.')

const manifest = read('plugin.json')
const expected = `${manifest.name}--v${manifest.version}`

if (tag !== expected) {
  fail(
    `The tag is ${tag} but the manifest says ${expected}.`,
    'Bump "version" in .claude-plugin/plugin.json, commit it, then tag again.',
  )
}

let market
try {
  market = read('marketplace.json')
} catch {
  fail('There is no .claude-plugin/marketplace.json, so nobody could install this from the repository.')
}

if (!market.plugins?.some(one => one.name === manifest.name)) {
  fail(`The marketplace file does not list ${manifest.name}, so the install line would not resolve it.`)
}

console.log(`${tag} matches the manifest, and the marketplace lists ${manifest.name}.`)
