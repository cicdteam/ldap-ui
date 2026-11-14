import { byteLength, imageType } from '../lib/display'
import { ldifPreview } from '../lib/ldif'

/**
 * LDIF as text, with binary values summarized (and pictures shown) and non-ASCII text decoded
 * instead of base64. The utf-8 mark is not selectable, so selected text copies as plain values.
 */
export function LdifView({ ldif, className }: { ldif: string; className?: string }) {
  return (
    <pre className={className}>
      {ldifPreview(ldif).map((p, i) => {
        if ('text' in p) return p.text + '\n'
        if ('utf8' in p)
          return (
            <span key={i} className="block">
              {p.attr}: {p.utf8}
              <span
                aria-hidden
                title="Shown decoded; Copy LDIF and downloads keep it as base64 (RFC 2849)"
                className="ml-2 text-[10px] text-muted select-none"
              >
                utf-8
              </span>
            </span>
          )
        const type = imageType(p.base64)
        return (
          <span key={i} className="block">
            {p.attr}:: <span className="text-muted">(binary, {byteLength(p.base64)} bytes)</span>
            {type && (
              <img
                src={`data:${type};base64,${p.base64}`}
                alt={p.attr}
                className="my-1 block max-h-24 rounded border border-border"
              />
            )}
          </span>
        )
      })}
    </pre>
  )
}
