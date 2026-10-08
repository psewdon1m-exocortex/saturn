# Local pipeline and Neptune fleet preview

The Vite development server can add owner-authenticated mock connections to the
Synchronization page. Enable this from the Saturn repository directory:

```powershell
Set-Content -LiteralPath '.tmp/pipeline-mocks.enabled' -Value 'enabled' -Encoding ascii
```

Refresh http://127.0.0.1:5173/synchronization. The fixture contains:

- Four host recovery connections: Updater, Neptune, Gryphon and Wyvern.
- Volt with archive and mirror, Mastermind with mirror only, and Chronos with archive only.
- Two Windows clients, each with its own mock folder assignment.
- Seven Linux fleet agents: six online, one offline. One agent has a pending
  policy revision and one reports a simulated archive error.
- Two Windows fleet clients: one online, one offline.

Names, versions, archive paths and setup-code previews identify the data as MOCK.
Online observations are refreshed when the UI polls. Real identities remain in
the API lists alongside the fixtures. The underlying API on port 3000, database,
storage, and real agent control plane contain no fixture identities or archives.

Setup code returns a deliberately non-redeemable preview. Revoke changes only
the in-memory mock identity; this persists across browser refreshes and resets
when Vite restarts. Unsupported actions on mock identities return an explicit
preview error rather than reaching the real control plane. Add pipeline remains
the normal real enrollment flow; use the existing MOCK rows to inspect simulated
connections.

The middleware requires a valid session from the real Saturn API and checks
origin and CSRF for mock mutations. It runs only in Vite development mode;
production builds and preview serving have no mock middleware, and mock code
does not enter browser assets.

Disable the preview without restarting the application:

```powershell
Remove-Item -LiteralPath '.tmp/pipeline-mocks.enabled'
```

Fixtures are implemented in `apps/web/dev/pipeline-mocks.ts`. Tests cover session
requirements, real-data preservation, mock capabilities, CSRF, isolated revoke,
and the development gate.
