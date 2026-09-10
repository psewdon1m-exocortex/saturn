# Stage 16 — Archives and Quick Preview

Status: `COMPLETE_LOCAL`

## Objective

Add useful file recognition, owner-only inline previews and durable archive
operations without giving the browser, 7-Zip or a worker direct Storage Box
credentials. Every source read and committed result still passes through the
Gateway `FileService` and its configured `StorageAdapter`.

## Entry state

- Stage 15 runtime storage selection is locally complete.
- The owner file manager has stable resource IDs, multi-selection, overwrite,
  trash and Dashboard task controls.
- API and worker use the same active runtime storage profile.
- The hidden `_system` layout and a bounded local temporary directory are
  available.

## Delivered behavior

### File recognition and preview

- New uploads are classified from a bounded content probe. A filename is used
  for text formats only after the bytes pass a text check; image, audio, video,
  PDF and archive signatures are detected from content.
- The file manager renders a type icon for folders, images, video, audio,
  documents and archives. Image and video rows use lazy inline media previews.
- Space opens the single selected previewable file. Space or Escape closes the
  modal. Double-click and the selection toolbar expose the same action.
- Images, browser-supported video/audio, PDF, Markdown and safe text formats are
  supported. Markdown is parsed and sanitized before insertion. PDF rendering
  uses PDF.js. Unsupported office/binary formats keep their icon and download
  action but do not advertise a preview.
- Preview responses are owner-authenticated, deny `volt`, use an allowlisted
  response MIME, `nosniff`, a sandboxed CSP and Range delivery. Legacy
  `application/octet-stream` records are probed from their actual bytes before
  becoming eligible; the extension alone cannot turn arbitrary binary data
  into an inline response.

### ZIP creation and ZIP/RAR extraction

- `Compress to ZIP` accepts the current selection and asks for the output name.
  It preserves nested paths and creates only ZIP output.
- `Extract here` accepts ZIP and RAR files. The result is a sibling folder named
  after the archive; a numeric suffix is selected when that name is already in
  use.
- Archive work is represented by persistent PostgreSQL jobs and processed by
  the bounded worker. Dashboard Tasks receives real archive state, progress,
  current member and byte counts.
- Pause exits the current worker attempt at a safe streaming checkpoint, clears
  its lease and makes the job resumable after a page or process restart. Resume
  requeues it from source. Cancel is terminal. Verification and final commit are
  deliberately non-pausable.
- ZIP output is streamed into a private local spool and uploaded only after a
  digest pass. Extraction inventories the archive before writing, validates the
  local tree, then commits through `FileService`. A failed partial extraction is
  moved to Saturn trash.
- RAR is read-only and delegated to the configured 7-Zip executable. Saturn
  never creates RAR archives.

## Archive safety contract

The validated runtime configuration bounds source archive bytes, member bytes,
total extracted bytes, entry count, compression ratio, upload chunk size and
worker lease duration. ZIP and RAR members reject absolute paths, traversal,
backslashes, control characters, duplicate ZIP paths, links and special files.
The local destination is resolved below the per-job spool root before every
write. Password-protected or malformed archives fail as jobs without committing
a visible result.

## Runtime states

```text
queued -> scanning -> compressing|extracting -> verifying -> committing -> completed
                   \-> paused -> queued (resume)
any interruptible state -> cancelled
any processing state -> failed
```

Input state is a stable selection or one active ZIP/RAR resource in a non-root
folder. Output state is either one verified active ZIP/file tree, or a terminal
job with a safe failure code and no partially active extraction tree.

## API and UI surfaces

| Surface | Contract |
| --- | --- |
| `POST /api/v1/archives/jobs` | Queue ZIP creation from stable resource IDs |
| `POST /api/v1/archives/resources/:id/extract` | Queue ZIP/RAR extraction beside the source |
| `GET /api/v1/archives/jobs` | List recent jobs, optionally scoped to a folder |
| `PATCH /api/v1/archives/jobs/:id` | Pause, resume or cancel a controllable job |
| `GET /api/v1/files/:id/preview` | Authenticated allowlisted inline Range stream |
| Storage context menu | Extract or compress the current resource/selection |
| Dashboard Tasks | Real archive lifecycle, bytes, progress and task controls |

## Exit state and evidence

- TypeScript checks pass for archive, file core, API, worker and web projects.
- Archive unit tests pass traversal/name/format rules.
- File-core tests pass content-derived Markdown/SVG classification and binary
  rejection.
- API, worker and web suites pass, including selection-to-ZIP, extraction and
  keyboard Quick Preview behavior.
- A live authenticated DEV run against the selected SFTP profile completed ZIP
  creation, 7-Zip inventory, extraction, byte equality, Markdown preview,
  pause/resume and cancellation. Its generated tree was moved to trash and its
  local spool artifact was deleted.

## Rollback

Stop the archive worker, allow no new archive jobs, and roll back migration
`0025_preview_archive_jobs` only after terminal jobs no longer need their
history. The preview UI/API can be rolled back without changing stored bytes.
Completed ZIPs and extracted trees are ordinary Saturn resources and remain
under normal versions/trash policy.
