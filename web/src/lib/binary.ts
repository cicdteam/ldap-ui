import { imageType } from './display'
import { splitDN } from './dn'
import { bytesToBase64 } from './ldif'
import { attrKey, type SchemaIndex } from './schema'
import type { Value } from './types'

const syntaxes = (...n: number[]) => new Set(n.map((x) => `1.3.6.1.4.1.1466.115.121.1.${x}`))
// Certificate, CertificateList, CertificatePair, SupportedAlgorithm: RFC 4522 sends them as ;binary.
const CERT_SYNTAXES = syntaxes(8, 9, 10, 49)
// What schema.IsBinary takes as binary on the server: audio, binary, certificate, certificate
// list, certificate pair, JPEG, octet string.
const BINARY_SYNTAXES = syntaxes(4, 5, 8, 9, 10, 28, 40)
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' }

/** Whether name's values are certificates, which the directory takes as name;binary. */
export function needsBinaryOption(name: string, schema: SchemaIndex): boolean {
  return CERT_SYNTAXES.has(schema.syntax(name))
}

/**
 * name with every character a file name cannot hold, on any system, made '_', and control and
 * format characters too: a bidi override (U+202E) can make a name read backwards.
 */
export function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, '_')
}

/**
 * The file a binary value downloads as: <RDN>-<attribute>[-N].<ext>, N counting from 2 for the
 * second value on; the extension from the image signature, cer for certificates, else bin.
 */
export function fileName(
  dn: string,
  attr: string,
  index: number,
  b64: string,
  schema: SchemaIndex,
): string {
  const ext = EXT[imageType(b64) ?? ''] ?? (needsBinaryOption(attr, schema) ? 'cer' : 'bin')
  const rdn = splitDN(dn)[0] || 'entry'
  return fileSafe(`${rdn}-${attr}${index ? `-${index + 1}` : ''}.${ext}`)
}

/** Standard base64 as bytes. */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

const hasBinaryOption = (name: string) => attrKey(name).split(';').slice(1).includes('binary')

/** Whether name takes files, not text: ;binary, a binary syntax, or base64 values already. */
export function isBinaryAttr(name: string, schema: SchemaIndex, values: Value[] = []): boolean {
  return (
    hasBinaryOption(name) ||
    BINARY_SYNTAXES.has(schema.syntax(name)) ||
    values.some((v) => v.base64)
  )
}

/** name with ;binary, unless it has it. */
export function withBinaryOption(name: string): string {
  return hasBinaryOption(name) ? name : `${name};binary`
}

/** The largest file a value takes, as the server checks it once decoded. */
export const MAX_FILE = 1 << 20

/**
 * A file's bytes as standard base64. A file over MAX_FILE is refused, and so is an empty one: LDAP
 * takes no empty value, and the batch drops one.
 */
export async function readFile(file: Blob): Promise<string> {
  if (file.size > MAX_FILE) throw new Error('File is larger than 1 MiB')
  if (file.size === 0) throw new Error('File is empty')
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()))
}
