import test from 'node:test'
import assert from 'node:assert/strict'
import { toCsv } from './csv.js'

test('CSV preserves positional headers and Unicode while escaping comma, quote and line breaks', () => {
  assert.equal(toCsv(['title', 'title', 'notes'], [
    ['Detroit, 夜', 'a "quoted" song', 'first\nsecond'],
    ['écho', 'plain', 'carriage\rreturn'],
  ]), 'title,title,notes\r\n"Detroit, 夜","a ""quoted"" song","first\nsecond"\r\nécho,plain,"carriage\rreturn"\r\n')
})

test('CSV preserves zero and other numbers, with null represented by an empty field', () => {
  assert.equal(toCsv(['zero', 'negative', 'decimal', 'missing', 'empty'], [[0, -7, 1.25, null, '']]),
    'zero,negative,decimal,missing,empty\r\n0,-7,1.25,,\r\n')
})

test('CSV exports returned headers even when the query has no rows', () => {
  assert.equal(toCsv(['a,b', '"name"'], []), '"a,b","""name"""\r\n')
})
