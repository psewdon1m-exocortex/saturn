# Sync ingress contract

Every reverse proxy between Neptune/Pluto and Saturn must route `/sync/v1/`
unchanged to the API, alongside `/api/v1/` and DAV. The production example is a
template; updating it does not change an installed server.

For guarded traffic, preserve Authorization, Content-Type/Encoding, conditional
headers, offsets, operation metadata and response Retry-After/ETag. Do not replace
API errors with HTML or intercept authentication responses. A proxy's 407 requires
proxy credentials; 401/403 alone does not prove that Saturn revoked registration.

The sync route permits 40 MiB requests, covering 32 MiB small-batch data,
4 MiB metadata and multipart framing (the API still enforces precise limits).
It disables request/response buffering, caching and upstream replay. Apply these
settings at **every** hop. Never retry a mutation just because a connection or
response was lost: recover status using the original operation identity first.
The application retains accepted operations after client disconnect.

Timeouts are phase-specific: upstream connect 10 s, guarded ingress inactivity
60 s, server long poll at most 25 s, Neptune full long-poll deadline 45 s and
ordinary control deadline 30 s. Neptune data transfer uses 30 s without progress,
without a short whole-file deadline. Server-side work can finish after a client
deadline; recovery must inspect its original durable result. Existing Saturn
small-batch admission/request budgets still apply. DAV retains its unlimited
request size in Nginx and server upload limits; the global 3600 s proxy timeouts
are inactivity limits, not whole-file durations.

Pluto uses complete control/long-poll deadlines of 45 s and data inactivity of
30 s, including chunk and small-batch transfers, without a whole-transfer timer.
Legacy server-side copy retains a separate 120 s response-header wait after
upload, followed by the same 30 s body inactivity deadline. Connect/TLS budgets
are 10 s. Proxy changes take effect when the configured service/session reopens;
Linux environment proxy settings are process inputs, not Windows system settings.

Qualification of an actual proxy chain must exercise lost responses after commit,
stalled bodies, chunk resume, long polls, 407, Retry-After and restart with pending
operations. Template tests do not qualify an installed deployment or OS Wi-Fi/VPN
transitions.
