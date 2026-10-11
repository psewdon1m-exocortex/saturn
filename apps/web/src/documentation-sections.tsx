import { isValidElement, type ReactNode } from "react";

export const DOCUMENTATION_REVISION = "2026-10-11";
export interface DocumentationSection {
  readonly id: string;
  readonly group: "Get Started" | "Operate" | "Maintain";
  readonly title: string;
  readonly summary: string;
  readonly keywords: string;
  readonly content: ReactNode;
}

export const DOCUMENTATION_SECTIONS: readonly DocumentationSection[] = [
  {
    id: "guide-introduction", group: "Get Started", title: "Introduction",
    summary: "Saturn stores, protects and delivers files through one Gateway.", keywords: "architecture SFTP Storage Box owner",
    content: <>
      <p>The owner workspace, Drop Point, shared links, Neptune and Pluto all use Saturn Gateway. The Gateway mediates access to the active SFTP storage; browsers and agents never receive its credentials. PostgreSQL holds the catalog, identities, versions and durable task state.</p>
      <p>This guide covers everyday file operations, connecting backup producers, checking their results and recovering from interruptions. An online agent, a completed upload and a proven restore are different observations.</p>
      <p className="documentation-note"><strong>Recovery scope:</strong> a Saturn recovery ZIP protects the control plane. It does not contain the original stored file bytes. Keep an independent copy of those bytes and the required recovery secrets.</p>
    </>,
  },
  {
    id: "guide-access", group: "Get Started", title: "Access and prerequisites",
    summary: "Sign in with the owner Access Key; give external clients their own scoped connection.", keywords: "login authentication Kernel token outdoor CSRF",
    content: <>
      <p>Use Saturn's HTTPS address in a modern browser and enter the owner Access Key. The key is masked and is not retained in browser storage. The authenticated cookie session and same-origin CSRF checks protect owner mutations. An expired session returns you to login.</p>
      <p>Do not give that Access Key to a backup producer or a shared-link recipient. Drop sessions, shares, Windows clients, Pluto and service producers have separate capabilities and revocation lifecycles.</p>
      <p>The deployment needs healthy API, worker, PostgreSQL and web processes, a writable storage target with a verified SFTP host fingerprint, and enough space in the local transfer/recovery buffers. Configure Kernel connection in Settings → Security when using Register discovery and service integration.</p>
      <p>Settings → Security → Access Key rotation asks for the exact current key, replaces it and revokes other owner sessions. Save the new key securely before dismissing the result. Keys and tokens must not appear in screenshots, support logs or this guide's search queries.</p>
    </>,
  },
  {
    id: "guide-navigation", group: "Get Started", title: "Workspace and first upload",
    summary: "Choose a folder in Storage or Storage new before uploading files.", keywords: "Dashboard Documentation sidebar root folders quick upload",
    content: <>
      <p>Dashboard shows observed capacity, reachability and tasks. Storage is the original table; Storage new is the optional card presentation of the same resources. Drop Point, Shared, Synchronization, Trash and Settings retain their dedicated workflows.</p>
      <ol><li>Open Storage or Storage new and enter an existing folder, or create an ordinary folder at root.</li><li>Choose Upload here or drop ordinary files into the current folder.</li><li>Wait for committed storage, then download a sample and verify the file you expected.</li></ol>
      <p>Direct file uploads into root are blocked. The preinstalled roots beginning with <code>#</code> are system-owned and cannot be renamed, moved or trashed by clients. Ordinary root folders remain fully manageable.</p>
      <p>Breadcrumbs and nested URLs identify the current folder. Appearance controls the accent, sidebar mode and saved navigation order. With auto-hide enabled, the content uses the full width; move to the left edge or focus Reveal navigation to reopen the overlay menu. Documentation remains a separate destination: its search filters this guide locally and clears when you leave and reopen it.</p>
    </>,
  },
  {
    id: "guide-storage", group: "Operate", title: "Storage and Storage new",
    summary: "Browse, sort and select the same files using either presentation.", keywords: "selection context menu copy cut paste rename move folder",
    content: <>
      <p>Search narrows the current folder; sort by name, modification time or size. Click a folder to open it. In Storage new, the visual area opens a folder or Quick Preview; click a name or card metadata to select it. Cards have no checkboxes or ellipsis buttons, and selecting does not show an action toolbar.</p>
      <p>Storage new has Back and Forward arrows for visited folder paths in the current browser session, and Up one level for the parent folder. Unavailable directions are disabled. Back and Forward stay within Storage new; a page reload starts a new navigation history.</p>
      <p>Use Ctrl/Cmd for multiple selection and Shift for a range. In Storage new, right-click a card for actions or the grid background for folder actions. Shift+F10 or the context-menu key opens the same menu from keyboard focus; Escape closes it and returns focus. The original Storage retains its selection toolbar. The allowed rename, move, copy, cut/paste, download, share, version, archive and trash actions follow the current resource policy; changing presentation does not bypass it.</p>
      <p>Copy creates another resource. Move and rename keep the original resource identity, so valid links can continue to refer to it. Destructive operations use an explicit confirmation. Check the destination and the selected item count before confirming.</p>
      <p>Both tabs use the same owner session, upload controller, versions, backend protections and stored data. Switching tabs does not create a second storage target.</p>
      <p>In Storage new, Shared on a card opens a light access dialog. Copy link loads the URL for copying; Access, expiry, password and status show its current policy. Revoke link stops access immediately while keeping your files. Escape closes the dialog and returns focus to the card control.</p>
      <p>New folder opens a light form showing the destination path. Enter Folder name and choose Create folder; the new folder is added to the current location. Cancel or Escape closes the form.</p>
    </>,
  },
  {
    id: "guide-upload", group: "Operate", title: "Uploads and interruptions",
    summary: "Sending all bytes is followed by verified commit; preserve the source until that succeeds.", keywords: "Upload here drag and drop Resume upload cancel failed network buffer quota",
    content: <>
      <p>Upload here accepts multiple ordinary files. Drag and drop uses the same pipeline. Dropped directories are skipped with an explanation: open the directory and select its files, or use Neptune/Pluto for a folder tree. Root uploads are disabled in both Storage presentations.</p>
      <p>Uploads use exact offsets and checksum verification. A file becomes available only after commit. Transfer progress reaching 100% is not by itself evidence that stored bytes have been published.</p>
      <p>If a recoverable owner upload is interrupted, keep the original file unchanged and use the offered resume flow. Reselect the matching file when requested; Saturn checks its identity and the server offset. A changed file, expired upload or conflicting destination may require a fresh upload.</p>
      <p>Cancel stops the pending transfer; it does not delete a file already committed. Check the result and current folder before retrying a request whose final response was lost. A browser reload does not retain the actual local file handle.</p>
      <p>Settings → Security → Drop upload buffer configures the shared local capacity and maximum file size for owner and Drop uploads. The maximum must fit below the 90% refusal watermark. Quota or insufficient-space refusal preserves existing files; free capacity or change the configured limit before retrying.</p>
    </>,
  },
  {
    id: "guide-download", group: "Operate", title: "Downloads and Quick Preview",
    summary: "Download file bytes or a folder ZIP; preview support depends on the file type.", keywords: "Range PDF image video Markdown Space browser Save ZIP",
    content: <>
      <p>Download sends a file through the Gateway. Folder download builds a bounded ZIP and uses the same authorization boundary. For a large or interrupted transfer, the browser may support Range continuation; keep the resource/version stable and verify the final download before treating it as a backup.</p>
      <p>Quick Preview supports recognized safe image, text/Markdown, PDF and media formats. Select a supported file and use its preview action or Space. PDF controls navigate pages and zoom. Unsupported, missing or failed previews do not imply that downloading the original is impossible.</p>
      <p>The browser owns the destination and final save. Server delivery completion means that Saturn finished sending the response; it cannot prove that the browser saved the file to disk. Cancelling a download stops delivery, and does not change the stored resource.</p>
      <p>Shared-link downloads have their own capability and limits. Preview availability is not a promise that recipients cannot save visible content.</p>
    </>,
  },
  {
    id: "guide-archives", group: "Operate", title: "Archives and task status",
    summary: "Compress to ZIP and Extract here run as durable worker tasks.", keywords: "Dashboard Tasks Pause Resume Cancel retry queued running failed completed ZIP RAR",
    content: <>
      <p>Select files/folders and choose Compress to ZIP, or select a supported ZIP/RAR and choose Extract here. Inspect the destination and task result. Unsafe paths, archive bombs, conflicts, unsupported input or configured limits can reject an operation without publishing partial output as a successful result.</p>
      <p>Queued and running tasks are work in progress. Paused tasks require Resume; completed tasks have finished their operation; failed and cancelled states require inspection. Use only the controls offered for the current phase: a commit in progress may not be cancellable.</p>
      <p>Dashboard → Tasks and the current operation's status show progress and errors. Worker restart recovery is journal-based; it does not turn a failed task into a success. After a connection loss, inspect the existing task before creating another archive.</p>
      <p>For confidence in a backup, download the completed archive, check its bytes and rehearse extraction or restore in an isolated destination. A green task alone is not a restore drill.</p>
    </>,
  },
  {
    id: "guide-versions", group: "Operate", title: "Versions and Trash",
    summary: "Overwrite and trash can be reversible within the applicable retention policy.", keywords: "restore history previous purge retention delete permanently",
    content: <>
      <p>Overwriting a file preserves prior contents as versions under that resource's policy. Versions lists retained active versions and offers the available restore/download actions. Restoring an older version changes the current contents; inspect the chosen timestamp and size first.</p>
      <p>Move to Trash hides a resource from ordinary storage. Trash → Restore brings back retained data. The Trash retention setting controls delayed removal; permanent purge and expired retention remove the recovery opportunity.</p>
      <p>Do not confuse a missing storage file with a trashed one. If bytes were deleted or overwritten outside Saturn, catalog metadata cannot reconstruct them. Restore from an independently retained version or backup.</p>
      <p>Retention varies by pipeline. Pluto keeps at most ten active versions per file including current. Do not assume that every category has that same limit or that Trash replaces an independent backup.</p>
    </>,
  },
  {
    id: "guide-sharing", group: "Operate", title: "Shared links",
    summary: "Create a read capability with the right mode, password, expiry and download limits.", keywords: "Shared current legacy revoke folder browse public link copy password",
    content: <>
      <p>Create a share from an allowed resource and choose the available view/download or folder browsing/package mode. Set password, expiry and download limits as needed. Confidential resource policies can forbid sharing.</p>
      <p>The current public share page and its legacy presentation access the same capability. Presentation does not change permissions. Share URLs are credentials: send them only to intended recipients and never enter them into search/diagnostic reports.</p>
      <p>Shared lists the owner's links, usage and state. Copy the URL when it is available. Historical hashed capabilities cannot be reconstructed: use the offered replacement/rotation flow when a URL is unavailable, and redistribute the new URL.</p>
      <p>Revoke stops future access while preserving stored files. Expiry, trash or stricter classification can also deny access. Already saved recipient copies remain outside Saturn's control; a revoke cannot erase them.</p>
    </>,
  },
  {
    id: "guide-drop", group: "Operate", title: "Drop Point and Gryphon",
    summary: "An upload-only channel admits clients by a short-lived code and delivers buffered files to Drop Point.", keywords: "drop drop_status drop_revoke Remove reserved uploading buffered draining stored failed_final code session",
    content: <>
      <p>The owner Drop Point view uses the common file pipeline. External clients open the public /drop page and enter a Drop code there. Gryphon's connected Telegram account can request /drop, inspect /drop_status and revoke /drop_revoke. Bot pairing and Saturn function binding are separate from the Drop code.</p>
      <p>A Drop code is a short-lived multi-client admission capability, not an owner login or a one-use enrollment code. Clients admitted to that channel share its absolute lifetime, quota and queue. Codes must be entered only on the intended Saturn Drop page.</p>
      <p>Reserved/uploading means the browser is still sending. Buffered means local staging succeeded; draining means the worker is sending to storage; stored is the successful final state. A retry/failure is not stored. Keep your source while a delivery is pending.</p>
      <p>Remove is offered for cancellable pending items. If a delivery fails, inspect its error and quota/storage state before retrying. An interrupted browser upload can resume through the offered session flow; expiration and revoke prevent further client access.</p>
      <p>Revocation reports the active sessions and codes affected by its identity/channel scope. Those counts are not the number of all historical codes or stored files. Stored files remain available to the owner; pending delivery status must still be inspected.</p>
    </>,
  },
  {
    id: "guide-pipelines", group: "Operate", title: "Synchronization and service backups",
    summary: "Create scoped pipelines in Synchronization; control automatic service schedules in the producing service.", keywords: "Add pipeline Setup code Revoke Neptune fleet online offline EXPORT_NOT_COMPLETED Volt Mastermind",
    content: <>
      <p>Add pipeline selects a host recovery, internal service, Volt/Mastermind, Windows or Pluto type. Internal/host connections identify the host; Windows and Pluto ask for a connection name. Enter the one-time Setup code in the intended agent/component before its displayed expiry. The code and resulting credential serve different purposes.</p>
      <p>Service pipelines receive recovery archives. Volt and Mastermind can select archive, mirror or both during registration. Their mirrors expose ordinary files in the assigned service tree. Automatic archive policy belongs to Settings → Backup in the producing service, not a global Saturn scheduler.</p>
      <p>Neptune fleet separately counts Linux, Windows and Pluto. Online means a recent heartbeat received by Saturn. Registered, online, enabled copying and last successful backup are independent states. Inspect last success, last attempt, next schedule and Recent ZIP runs.</p>
      <p>EXPORT_NOT_COMPLETED means the producing service did not finish its export; a heartbeat does not fix that failure. Check the producer and Neptune diagnostics. Revoke disconnects that pipeline and its linked access while retaining stored files and archives.</p>
    </>,
  },
  {
    id: "guide-host-backups", group: "Operate", title: "Host services recovery",
    summary: "Updater, Neptune, Gryphon, Wyvern and Window use independent encrypted recovery pipelines.", keywords: "host backups Server ID recovery key Create recovery archive Kernel Register Saturn URL 403",
    content: <>
      <ol><li>In Add pipeline choose the installed host component's recovery type and the host name. Create or renew its Setup code on that same connection.</li><li>On the Linux host open <code>sudo updater tui</code>, select that component's recovery connection and enter the code. Normal discovery resolves Saturn from Kernel Register through the configured Kernel connection.</li><li>Create/export the component's recovery key into an absolute path you control. Record that path and preserve a separate protected copy. A code is not the decryption key.</li><li>Run the offered component recovery archive action. Verify the completed job, its matching Recent ZIP run in Saturn and a downloaded archive. Rehearse decryption/restore on an isolated host before relying on it.</li></ol>
      <p>Each component writes only into <code># sync inner services/&lt;service&gt;/&lt;host&gt;</code> and has its own setup/revoke lifecycle. Connecting Updater does not automatically enroll the other host services. Reissuing a connection code does not require discarding the existing recovery key.</p>
      <p>If discovery returns HTTP 403, inspect the Kernel token's allowed Register values and the installed component versions. An Advanced recovery Saturn origin override is an operator fallback, not the standard discovery requirement. Use the canonical HTTPS origin only.</p>
      <p>Never edit job history or delete existing archives to conceal a failure. Component diagnostics and the recorded job ID distinguish connection failure, export validation failure and upload failure.</p>
    </>,
  },
  {
    id: "guide-windows", group: "Operate", title: "Neptune Windows",
    summary: "A Windows profile copies selected local directories into its own sync folder.", keywords: "PC client connection name setup DPAPI tray one-way local files",
    content: <>
      <p>Install the verified Neptune Windows distribution on the PC. Configure its Kernel connection, create a Windows synchronization pipeline in Saturn with a connection name and enter its Setup code in Neptune. The resulting scoped credential is returned to the client, not shown as the owner Access Key.</p>
      <p>Select the local directories in the client and enable its copying workflow. Saturn displays the mirror under <code># sync windows/&lt;connection&gt;</code>; the stable WebDAV route remains <code>/dav/sync</code>, and other clients' folders are outside that credential's scope. The client protects stored tokens with the Windows user's DPAPI and can run in the tray.</p>
      <p>This version is one-way: it does not restore server changes onto the PC. Keep the local source and examine conflicts/failures before changing it. A remote restore is an explicit download/recovery operation.</p>
      <p>Check the client status, heartbeat and stored files separately. Revoke stops that client's server access and preserves previously stored files. Legacy unbound clients require an isolated setup rather than broad access to the entire sync root.</p>
    </>,
  },
  {
    id: "guide-pluto", group: "Operate", title: "Pluto outdoor backups",
    summary: "A standalone Linux agent copies ordinary files and folders; enrollment leaves copying disabled.", keywords: "Outdoor service tokens Kernel Register Files and folders Add files or folders Remove a source Copy now interval symlink database ten versions 256 MiB",
    content: <>
      <ol><li>Install Pluto's signed Linux bootstrap. In Kernel Register configure Saturn's service address values and Pluto's release repository.</li><li>In Kernel Settings → Security → Outdoor service tokens create an installation token. Enter that limited token and Kernel HTTPS URL in <code>sudo pluto tui</code>; do not use the unrestricted internal service token.</li><li>In Files and folders add absolute source paths, one per line. Set the copy interval (default 24 hours; supported range 60 seconds to one year). The pluto service account needs read/traversal permissions even when TUI is opened with sudo.</li><li>In Saturn choose Pluto · Linux files and folders, enter only a connection name and issue Setup code. Enter it in Pluto within 15 minutes, then enable copying separately.</li></ol>
      <p>The source hierarchy is stored directly under <code># sync outdoor connections/&lt;connection name&gt;</code>, including empty directories. No ZIP password is involved. Copy now requests an immediate copy. One installation uses one pipeline and requires neither Updater nor Neptune to run.</p>
      <p>Only changed contents create versions; at most ten active versions per file, including current, are retained. Source removal/deletion keeps stored copies. Removing the last configured source disables copying. Disable copying and let an active run stop before changing sources.</p>
      <p>Files are limited to 256 MiB. Regular-file symbolic links copy their target bytes at the link's path; directory, broken/cyclic links and special files are rejected. Unix ownership, permissions, timestamps and link metadata are not preserved. Unreadable sources produce a partial failure while healthy sources can still copy.</p>
      <p className="documentation-note"><strong>Database consistency:</strong> select completed database dump/backup files. Copying a live database file is not an application-consistent backup. Keep recovery secrets and an independent copy separately.</p>
      <p>Pluto appears separately in Neptune fleet. Revoke stops its access and keeps files/versions. Check Pluto's last attempt, last success and source failures; an online heartbeat alone does not prove that copying is enabled or complete.</p>
    </>,
  },
  {
    id: "guide-storage-connection", group: "Maintain", title: "Storage connection and catalog",
    summary: "Switching targets rebuilds the catalog without migrating bytes; analysis reconciles the active target.", keywords: "Settings Test connection Analyze storage Synchronize catalog missing stale report SFTP fingerprint",
    content: <>
      <h3>Changing the target</h3>
      <p>Settings → Storage connection accepts an independent SFTP target, verified host fingerprint and credential. Test and explicitly select the target. The change rebuilds the visible catalog and revokes capabilities tied to the previous file set. No file bytes are migrated; the previous target's contents remain untouched.</p>
      <p>To return, validate/select the previous target again with its credential. Check its catalog and agent access after the switch. Do not mistake an empty independent target for lost files on the old one.</p>
      <h3>Reconciling external changes</h3>
      <p>Analyze storage produces a saved differences report without modifying file bytes. Review additions, changed metadata, absent files and blockers. Confirm Synchronize catalog only against a fresh report: it imports unseen files, updates metadata and marks absent resources as missing while preserving existing resource IDs where paths match.</p>
      <p>Affected shares are revoked. An external overwrite cannot recreate old bytes from metadata. External rename can appear as an absent old path and an imported new path. Invalid paths, unsupported entries, protected-root loss and collisions block application; resolve them and analyze again. A stale report requires a new analysis.</p>
    </>,
  },
  {
    id: "guide-recovery", group: "Maintain", title: "Saturn backup and restore",
    summary: "A verified control-plane ZIP must be paired with matching storage bytes and protected recovery secrets.", keywords: "Settings Backup Create snapshot Restore RESTORE maintenance guard migration RPO RTO",
    content: <>
      <p>Settings → Backup → Create snapshot creates and validates a logical PostgreSQL dump, portable metadata and safe configuration/deployment inputs. Save the complete downloaded ZIP and verify it. Recovery readiness checks include tools, writable spool, available space and absence of an interrupted restore guard or another active recovery operation.</p>
      <p className="documentation-note"><strong>Not a full file backup:</strong> the ZIP excludes original stored file bytes and secret credentials. Preserve matching current/retained storage versions, encrypted secret recovery material and a separate second copy. Quiesce writers for a coordinated recovery point.</p>
      <ol><li>Select the ZIP in Restore. Upload and validation finish before database mutation.</li><li>Review the displayed archive identity, creation time, size, schema and checksum. Confirm control-plane replacement with the requested RESTORE text.</li><li>During maintenance, Saturn preserves the original schema, applies the candidate and forward migrations, and verifies referenced stored file lengths/checksums.</li><li>After success, sign in again and review restored producer schedules before resuming them. Restored browser sessions are intentionally absent.</li></ol>
      <p>Validation failures stop before mutation. Apply failures attempt to recover the previous configuration/schema. If rollback fails or a process is interrupted, the durable restore guard blocks ordinary traffic until operator recovery. Do not remove that guard or start writers manually to force the site open.</p>
      <p>A restore drill must use an isolated target and the actual intended software/database tuple. A successful snapshot download is not proof of disaster recovery.</p>
    </>,
  },
  {
    id: "guide-updates", group: "Maintain", title: "Updates and compatibility",
    summary: "Save the pre-update ZIP, then let Updater migrate and replace a coordinated release.", keywords: "Settings Updates Install rollback ROLLBACK_FAILED 502 immutable production",
    content: <>
      <p>Settings → Updates checks a selected Saturn release. Before installation, create/save the required fresh recovery ZIP on the operator computer. Updater verifies the immutable application/web artifacts, applies migrations and checks replacement health. No update ZIP is retained as a permanent application-host backup.</p>
      <p>API, worker and web must come from a coordinated compatible release. Do not run an old worker against newly migrated write protocols. Shared Updater, Neptune, Gryphon, Wyvern and Window lifecycle operations belong to the host's <code>sudo updater tui</code>; Pluto updates itself through its own TUI.</p>
      <p>Installation states are authoritative job phases, not elapsed-time estimates. PULLING may not have a measured percentage. If the browser disconnects or reports 502, inspect the existing Updater job and component/container health before retrying installation.</p>
      <p>ROLLBACK_FAILED requires operator investigation with the saved ZIP, release identities, applied migrations and diagnostics. Preserve the historical job and backup evidence. Health checks returning green should be followed by a scoped file round trip and backup verification.</p>
    </>,
  },
  {
    id: "guide-diagnostics", group: "Maintain", title: "Diagnostics and recovery checks",
    summary: "Use the exact failed job and its phase to separate network, producer, storage and recovery faults.", keywords: "Settings Logs failure error 403 502 offline checksum failed_final EXPORT_NOT_COMPLETED troubleshooting",
    content: <>
      <div className="documentation-table-scroll" tabIndex={0} role="region" aria-label="Troubleshooting table">
        <table className="documentation-table"><thead><tr><th>Observation</th><th>Next check</th><th>Safe recovery</th></tr></thead><tbody>
          <tr><td>HTTP 403 resolving Saturn</td><td>Kernel token scope, Register references and component version</td><td>Correct discovery access; use an explicit HTTPS origin override only as an operator fallback.</td></tr>
          <tr><td>HTTP 502 after an update</td><td>Updater job, API/worker health and migration/rollback outcome</td><td>Preserve the saved ZIP and diagnose the existing job before another update.</td></tr>
          <tr><td>EXPORT_NOT_COMPLETED</td><td>Producing service export and Neptune diagnostics</td><td>Resolve the export failure; inspect a new completed ZIP run.</td></tr>
          <tr><td>Drop failed_final or stalled draining</td><td>Exact delivery job, storage readiness, buffer space and error</td><td>Keep the source; restore capacity/access and use the offered retry flow.</td></tr>
          <tr><td>Agent offline or no recent successful copy</td><td>Heartbeat age, enabled state, interval, source permissions and client status</td><td>Restore the client connection/permissions and verify stored bytes.</td></tr>
          <tr><td>Restore interrupted / rollback failed</td><td>Recovery journal, durable guard, preserved schema and active storage profile</td><td>Use the operator recovery procedure; do not discard the original schema or guard.</td></tr>
        </tbody></table>
      </div>
      <p>Settings → Logs and the relevant producer/component diagnostics supply evidence. Record job ID, time, phase and redacted error. Never include tokens, key files, .env contents, share URLs or original confidential file contents in support material.</p>
      <p>After a repair, verify upload/download byte equality, expected version/Trash behavior, one successful producer publication and an isolated restore where applicable. Backups on the same physical host do not cover loss of that host; independent storage and tested recovery remain necessary.</p>
    </>,
  },
];

export function documentationText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(documentationText).join(" ");
  if (isValidElement<{ children?: ReactNode }>(node)) return documentationText(node.props.children);
  return "";
}

export function filterDocumentation(query: string): readonly DocumentationSection[] {
  const normalized = query.trim().toLocaleLowerCase("en-US");
  return DOCUMENTATION_SECTIONS.filter(section => !normalized ||
    `${section.group} ${section.title} ${section.summary} ${section.keywords} ${documentationText(section.content)}`
      .toLocaleLowerCase("en-US").includes(normalized));
}
