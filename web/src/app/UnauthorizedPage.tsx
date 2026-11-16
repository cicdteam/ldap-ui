export function UnauthorizedPage() {
  return (
    <div className="h-full overflow-auto">
      <main className="mx-auto mt-[20vh] max-w-md px-4 text-center">
        <h1 className="mb-2 text-base font-semibold">Login link required</h1>
        <p className="text-muted">
          This ldaplens needs an access token. Open the login link (it ends with{' '}
          <code className="font-mono">?token=…</code>) printed in the server log, or ask whoever
          runs it.
        </p>
      </main>
    </div>
  )
}
