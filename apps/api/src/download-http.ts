/** Content validators describe bytes, and never grant access to a resource. */
export function downloadEtag(value: { readonly sha256?: string }): string | undefined {
  return value.sha256 === undefined ? undefined : `"sha256-${value.sha256}"`;
}

/** No Last-Modified validator is advertised: dates and weak tags restart safely. */
export function validatedRange(rawRange: string | undefined, ifRange: unknown, etag: string | undefined): string | undefined {
  if (ifRange === undefined) return rawRange;
  return typeof ifRange === "string" && etag !== undefined && ifRange === etag ? rawRange : undefined;
}
