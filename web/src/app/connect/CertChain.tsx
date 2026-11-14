import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert } from 'lucide-react'
import { api, toProfileInput } from '../../lib/api'
import type { CertInfo, Profile } from '../../lib/types'
import { ErrorBanner } from '../../ui/Banner'
import { Button } from '../../ui/Button'
import { CopyButton } from '../../ui/CopyButton'

/** The untrusted chain from a tls_untrusted error, with "trust this CA". */
export function CertChain({
  profile,
  certs,
  message,
  onTrusted,
}: {
  profile: Profile
  certs: CertInfo[]
  message: string
  onTrusted: () => void
}) {
  const qc = useQueryClient()
  const top = certs[certs.length - 1]
  const trust = useMutation({
    mutationFn: () => api.saveProfile({ ...toProfileInput(profile), caPEM: top.pem }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profiles'] }),
  })
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 text-danger">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /> {message}
      </p>
      <ol className="space-y-2">
        {certs.map((c, i) => (
          <li key={c.sha256} className="rounded border border-border p-2">
            <div className="text-xs text-muted">
              {i === 0 ? 'Server certificate' : `Issuer ${i}`}
            </div>
            <div className="font-mono text-xs break-all">{c.subject}</div>
            <div className="text-xs text-muted">
              issued by <span className="font-mono">{c.issuer}</span>, expires{' '}
              {new Date(c.notAfter).toLocaleDateString()}
            </div>
            <div className="font-mono text-[11px] break-all text-muted">
              SHA-256 {c.sha256.match(/../g)?.join(':')}
            </div>
          </li>
        ))}
      </ol>
      {top && profile.editable && (
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            disabled={trust.isPending}
            onClick={() => trust.mutate(undefined, { onSuccess: () => onTrusted() })}
          >
            Trust this CA and connect
          </Button>
          <span className="text-xs text-muted">
            Saves the last certificate above into this profile.
          </span>
        </div>
      )}
      {top && !profile.editable && (
        <div className="space-y-1">
          <p className="text-xs text-muted">
            This profile comes from connections.yaml. Check the fingerprint, then add the
            certificate there as
            <code className="font-mono"> caPEM</code> (or point{' '}
            <code className="font-mono">caFile</code> at it):
          </p>
          <div className="flex items-start gap-1">
            <textarea
              readOnly
              value={top.pem}
              rows={5}
              className="w-full rounded border border-border bg-panel p-1 font-mono text-[11px]"
            />
            <CopyButton text={top.pem} label="Copy PEM" />
          </div>
        </div>
      )}
      {trust.isError && <ErrorBanner error={trust.error} />}
    </div>
  )
}
