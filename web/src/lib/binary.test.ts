import { describe, expect, it } from 'vitest'
import {
  base64ToBytes,
  fileName,
  fileSafe,
  isBinaryAttr,
  MAX_FILE,
  needsBinaryOption,
  readFile,
  withBinaryOption,
} from './binary'
import { SchemaIndex } from './schema'

const schema = new SchemaIndex({
  attributeTypes: [
    {
      oid: '0.9.2342.19200300.100.1.60',
      names: ['jpegPhoto'],
      syntax: '1.3.6.1.4.1.1466.115.121.1.28',
    },
    { oid: '2.5.4.36', names: ['userCertificate'], syntax: '1.3.6.1.4.1.1466.115.121.1.8' },
    { oid: '2.5.4.13', names: ['description'] },
  ],
  objectClasses: [],
})
const DN = 'uid=jdoe,ou=people,dc=example,dc=org'

describe('needsBinaryOption', () => {
  it('holds for certificate syntaxes only', () => {
    expect(needsBinaryOption('userCertificate', schema)).toBe(true)
    expect(needsBinaryOption('userCertificate;binary', schema)).toBe(true)
    expect(needsBinaryOption('jpegPhoto', schema)).toBe(false)
    expect(needsBinaryOption('unknown', schema)).toBe(false)
  })
})

describe('fileName', () => {
  it.each([
    ['jpegPhoto', 0, '/9j/4AAQ', 'uid=jdoe-jpegPhoto.jpg'],
    ['jpegPhoto', 1, '/9j/4AAQ', 'uid=jdoe-jpegPhoto-2.jpg'],
    ['photo', 0, 'iVBORw0KGgoAAAA', 'uid=jdoe-photo.png'],
    ['photo', 0, 'R0lGODlhAQAB', 'uid=jdoe-photo.gif'],
    ['userCertificate;binary', 0, 'MIIBhjCC', 'uid=jdoe-userCertificate;binary.cer'],
    ['description', 2, 'AAEC', 'uid=jdoe-description-3.bin'],
  ])('%s #%i', (attr, index, b64, want) => {
    expect(fileName(DN, attr, index, b64, schema)).toBe(want)
  })
  it('replaces characters a file name cannot hold', () => {
    expect(fileName('cn=Doe\\, John/Jr: x?,dc=x', 'jpegPhoto', 0, '/9j/', schema)).toBe(
      'cn=Doe_, John_Jr_ x_-jpegPhoto.jpg',
    )
    expect(fileSafe('a<b>c|d*e"f\u0001')).toBe('a_b_c_d_e_f_')
    expect(fileName('', 'jpegPhoto', 0, '/9j/', schema)).toBe('entry-jpegPhoto.jpg')
  })
  it('replaces bidi and other control or format characters', () => {
    const name = fileName('cn=\u202egpj.exe,dc=x', 'jpegPhoto', 0, '/9j/', schema)
    expect(name).toBe('cn=_gpj.exe-jpegPhoto.jpg')
    expect(fileSafe('a\u007fb\u0085c\u009fd\u200be\u2066f')).toBe('a_b_c_d_e_f')
  })
})

describe('base64ToBytes', () => {
  it('decodes standard base64', () => {
    expect([...base64ToBytes('/9j/')]).toEqual([0xff, 0xd8, 0xff])
  })
})

describe('isBinaryAttr and withBinaryOption', () => {
  it.each([
    ['jpegPhoto', [], true],
    ['userCertificate', [], true],
    ['description;binary', [], true],
    ['description', [{ text: 'AAEC', base64: true }], true],
    ['description', [{ text: 'x' }], false],
    ['cn;lang-de', [], false],
  ])('%s', (name, values, want) => {
    expect(isBinaryAttr(name, schema, values)).toBe(want)
  })
  it('adds ;binary once', () => {
    expect(withBinaryOption('userCertificate')).toBe('userCertificate;binary')
    expect(withBinaryOption('userCertificate;Binary')).toBe('userCertificate;Binary')
  })
})

describe('readFile', () => {
  it('reads a file as base64', async () => {
    expect(await readFile(new Blob([new Uint8Array([0xff, 0xd8, 0xff])]))).toBe('/9j/')
  })
  it('takes 1 MiB and refuses a byte more, and an empty file', async () => {
    await expect(readFile(new Blob([new Uint8Array(MAX_FILE)]))).resolves.toHaveLength(1398104)
    await expect(readFile(new Blob([new Uint8Array(MAX_FILE + 1)]))).rejects.toThrow(
      'File is larger than 1 MiB',
    )
    await expect(readFile(new Blob([]))).rejects.toThrow('File is empty')
  })
})
