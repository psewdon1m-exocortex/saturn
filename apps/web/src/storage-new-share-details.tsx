import { useState } from "react";
import type { ShareInfo } from "./types.js";

// Presentation only: FilesView owns capability retrieval, clipboard and revocation.
export function StorageNewShareDetails({ share, url, pending, access, onCopy, onRevoke }: {
  readonly share: ShareInfo;
  readonly url: string | undefined;
  readonly pending: boolean;
  readonly access: string;
  readonly onCopy: () => Promise<void>;
  readonly onRevoke: () => void;
}) {
  const [copying, setCopying] = useState(false);
  const disabled = pending || copying || share.state !== "active";
  const copy = async () => {
    if (disabled) return;
    setCopying(true);
    try { await onCopy(); }
    finally { setCopying(false); }
  };
  return <div className="storage-new-share-details">
    <div className="storage-new-share-object">
      <p className="storage-new-share-kicker">Shared {share.resourceType}</p>
      <h3>{share.resourceName}</h3>
      <p>{share.state === "active" ? `Anyone with this link can access this ${share.resourceType} within the permissions below.` : "This shared link is inactive."}</p>
    </div>
    <section className="storage-new-share-link" aria-label="Shared link">
      <div className="storage-new-share-link__head"><strong>Share link</strong><button className="button button--primary" type="button" disabled={disabled} onClick={() => void copy()}>{copying ? "Copying…" : "Copy link"}</button></div>
      {url === undefined ? <p>{share.state === "active" ? "Copy the link to make it available here and send it to someone." : "This link is no longer available."}</p> : <input aria-label="Share link" value={url} readOnly onFocus={(event) => event.currentTarget.select()} />}
    </section>
    <dl className="storage-new-share-facts">
      <div><dt>Access</dt><dd>{access}</dd></div>
      <div><dt>Status</dt><dd>{{ active: "Active", revoked: "Revoked", expired: "Expired", exhausted: "Download limit reached" }[share.state]}</dd></div>
      <div><dt>Expires</dt><dd>{share.expiresAt === undefined ? "No expiry" : new Date(share.expiresAt).toLocaleString()}</dd></div>
      <div><dt>Password</dt><dd>{share.locked ? "Required" : "Not required"}</dd></div>
    </dl>
    <div className="storage-new-share-footer"><p>{share.state === "active" ? "Revoking the link stops access immediately. Your files stay in storage." : "Access through this link has stopped. Your files stay in storage."}</p><button className="button button--danger" type="button" disabled={disabled} onClick={onRevoke}>{pending ? "Revoking…" : "Revoke link"}</button></div>
  </div>;
}
