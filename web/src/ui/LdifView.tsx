import { byteLength, imageType } from '../lib/display'
import { ldifPreview } from '../lib/ldif'

/** LDIF as text, with binary values summarized (and pictures shown) instead of base64. */
export function LdifView({ ldif, className }: { ldif: string; className?: string }) {
  return (
    <pre className={className}>
      {ldifPreview(ldif).map((p, i) => {
        if ('text' in p) return p.text + '\n'
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
