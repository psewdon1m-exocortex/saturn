#!/bin/sh
set -eu
umask 077

REPOSITORY=${SATURN_RELEASE_REPOSITORY:-psewdon1m-exocortex/saturn}
SATURN_EXACT_RELEASE_VERSION="__SATURN_BOOTSTRAP_RELEASE_VERSION__"
SATURN_ED25519_PUBLIC_KEY_B64="__SATURN_BOOTSTRAP_ED25519_PUBLIC_KEY_BASE64__"
SATURN_RSA_PUBLIC_KEY_B64="__SATURN_BOOTSTRAP_RSA_PUBLIC_KEY_BASE64__"
MANIFEST_URL=${VAULT_MANIFEST_URL:-https://github.com/$REPOSITORY/releases/download/saturn-v$SATURN_EXACT_RELEASE_VERSION/release-manifest.json}
TRUSTED_PUBLIC_KEY=${VAULT_RELEASE_PUBLIC_KEY:-/etc/vault/release-public-key.pem}
RSA_TRUSTED_PUBLIC_KEY=${EXOCORTEX_SATURN_RELEASE_TRUST_FILE:-/etc/exocortex/release-trust/saturn.pem}
INSTALL_ROOT=${VAULT_INSTALL_ROOT:-/opt/vault}
MAX_MANIFEST_BYTES=1048576
MAX_BUNDLE_BYTES=104857600
BOOTSTRAP_MODE=prepare

case "${1:-}" in
  "") ;;
  --refresh) BOOTSTRAP_MODE=refresh ;;
  *) printf '%s\n' "usage: bootstrap.sh [--refresh]" >&2; exit 1 ;;
esac

die() { printf '%s\n' "saturn bootstrap: $1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"; }
[ "$(id -u)" -eq 0 ] || die "bootstrap requires root"
printf '%s' "$SATURN_EXACT_RELEASE_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "invalid embedded Saturn release version"
existing_install=false
if [ -e "$INSTALL_ROOT" ]; then
  [ "$BOOTSTRAP_MODE" = refresh ] || die "installation already exists; use --refresh only for a prepared, not-yet-started installation"
  [ -d "$INSTALL_ROOT" ] && [ -f "$INSTALL_ROOT/infra/production/install.sh" ] || die "existing installation is not a recognized Saturn bundle"
  existing_install=true
elif [ "$BOOTSTRAP_MODE" = refresh ]; then
  BOOTSTRAP_MODE=prepare
fi
if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl openssl openssh-client python3 unzip
fi
need curl; need openssl; need ssh-keygen; need python3; need unzip

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
case "$MANIFEST_URL" in https://*) ;; *) die "manifest URL must use HTTPS" ;; esac
release_base=${MANIFEST_URL%/release-manifest.json}
curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 --connect-timeout 10 --max-time 120 --max-filesize "$MAX_MANIFEST_BYTES" "$MANIFEST_URL" -o "$work/manifest.json"
printf '%s' "$SATURN_ED25519_PUBLIC_KEY_B64" | openssl base64 -d -A >"$work/saturn-ed25519.pem"
openssl pkey -pubin -in "$work/saturn-ed25519.pem" -noout >/dev/null 2>&1 || die "embedded Saturn Ed25519 release key is invalid"
if [ -e "$TRUSTED_PUBLIC_KEY" ]; then
  if [ ! -f "$TRUSTED_PUBLIC_KEY" ] || [ -L "$TRUSTED_PUBLIC_KEY" ] || ! cmp -s "$work/saturn-ed25519.pem" "$TRUSTED_PUBLIC_KEY"; then
    die "installed Saturn Ed25519 release key differs from this release"
  fi
fi
python3 - "$work/manifest.json" "$work/saturn-ed25519.pem" "$work" "$SATURN_EXACT_RELEASE_VERSION" <<'PY'
import base64,hashlib,json,pathlib,subprocess,sys
manifest_path,key_path,out,expected_version=sys.argv[1:]
m=json.loads(pathlib.Path(manifest_path).read_text())
p=m.get('payload',{}); s=m.get('signature',{})
if p.get('schema')!='vault.release-manifest.v1' or p.get('componentRole')!='vault-gateway' or p.get('version')!=expected_version or s.get('algorithm')!='Ed25519': raise SystemExit('invalid manifest identity')
def canonical(v):
  if isinstance(v,dict): return '{'+','.join(json.dumps(k,separators=(',',':'))+':'+canonical(v[k]) for k in sorted(v))+'}'
  if isinstance(v,list): return '['+','.join(canonical(x) for x in v)+']'
  return json.dumps(v,separators=(',',':'))
pathlib.Path(out,'payload').write_bytes(canonical(p).encode());pathlib.Path(out,'signature').write_bytes(base64.b64decode(s['value']))
r=subprocess.run(['openssl','pkeyutl','-verify','-pubin','-inkey',key_path,'-rawin','-in',str(pathlib.Path(out,'payload')),'-sigfile',str(pathlib.Path(out,'signature'))])
if r.returncode: raise SystemExit('manifest signature verification failed')
print(p['bundle']['sha256'][7:]);print(p['bundle']['bytes']);print(p['bundle'].get('url',''))
PY
install -d -o root -g root -m 0755 "$(dirname "$TRUSTED_PUBLIC_KEY")"
[ -f "$TRUSTED_PUBLIC_KEY" ] || install -o root -g root -m 0644 "$work/saturn-ed25519.pem" "$TRUSTED_PUBLIC_KEY"

printf '%s' "$SATURN_RSA_PUBLIC_KEY_B64" | openssl base64 -d -A >"$work/saturn.pem"
openssl pkey -pubin -in "$work/saturn.pem" -noout >/dev/null 2>&1 || die "embedded Saturn RSA release key is invalid"
if [ -e "$RSA_TRUSTED_PUBLIC_KEY" ]; then
  if [ ! -f "$RSA_TRUSTED_PUBLIC_KEY" ] || [ -L "$RSA_TRUSTED_PUBLIC_KEY" ] || ! cmp -s "$work/saturn.pem" "$RSA_TRUSTED_PUBLIC_KEY"; then
    die "installed Saturn RSA release key differs from this release"
  fi
fi
curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 --max-filesize "$MAX_MANIFEST_BYTES" "$release_base/saturn-release.json" -o "$work/saturn-release.json"
curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 --max-filesize 16384 "$release_base/saturn-release.json.sig.json" -o "$work/saturn-release.json.sig.json"
python3 - "$work/saturn-release.json" "$work/saturn-release.json.sig.json" "$work/saturn.pem" "$SATURN_EXACT_RELEASE_VERSION" <<'PYRSA'
import base64,hashlib,json,pathlib,re,subprocess,sys,tempfile
manifest,envelope,key=map(pathlib.Path,sys.argv[1:4]); expected_version=sys.argv[4]
signed=json.loads(envelope.read_text(encoding='utf8'))
data=json.loads(manifest.read_text(encoding='utf8'))
if data.get('service')!='saturn' or data.get('version')!=expected_version or signed.get('schema')!='exocortex.release-signature.v1' or signed.get('algorithm')!='RSA-PSS-SHA256': raise SystemExit('invalid Saturn updater manifest identity')
public=subprocess.run(['openssl','pkey','-pubin','-in',str(key),'-outform','DER'],check=True,capture_output=True).stdout
if hashlib.sha256(public).hexdigest()!=signed.get('key_id'): raise SystemExit('Saturn updater signer is not trusted')
description=subprocess.run(['openssl','rsa','-pubin','-in',str(key),'-text','-noout'],check=True,capture_output=True,text=True).stdout
bits=re.search(r'Public-Key: \((\d+) bit\)',description)
if not bits or int(bits[1])<3072: raise SystemExit('Saturn updater trust requires RSA-3072')
with tempfile.TemporaryDirectory(prefix='saturn-rsa-') as directory:
  signature=pathlib.Path(directory)/'signature.bin'; signature.write_bytes(base64.b64decode(signed['signature'],validate=True))
  subprocess.run(['openssl','dgst','-sha256','-verify',str(key),'-signature',str(signature),'-sigopt','rsa_padding_mode:pss','-sigopt','rsa_pss_saltlen:32',str(manifest)],check=True)
PYRSA
install -d -o root -g root -m 0755 "$(dirname "$RSA_TRUSTED_PUBLIC_KEY")"
[ -f "$RSA_TRUSTED_PUBLIC_KEY" ] || install -o root -g root -m 0644 "$work/saturn.pem" "$RSA_TRUSTED_PUBLIC_KEY"
fields=$(python3 -c "import json; p=json.load(open('$work/manifest.json'))['payload']; print(p['bundle']['sha256'][7:]); print(p['bundle']['bytes']); print(p['bundle'].get('url','')); print(p['version']); print(p['images']['app']); print(p['images']['web'])")
expected=$(printf '%s\n' "$fields" | sed -n '1p')
bytes=$(printf '%s\n' "$fields" | sed -n '2p')
bundle_url=$(printf '%s\n' "$fields" | sed -n '3p')
SATURN_BOOTSTRAP_RELEASE_VERSION=$(printf '%s\n' "$fields" | sed -n '4p')
SATURN_BOOTSTRAP_APP_IMAGE=$(printf '%s\n' "$fields" | sed -n '5p')
SATURN_BOOTSTRAP_WEB_IMAGE=$(printf '%s\n' "$fields" | sed -n '6p')
export SATURN_BOOTSTRAP_RELEASE_VERSION SATURN_BOOTSTRAP_APP_IMAGE SATURN_BOOTSTRAP_WEB_IMAGE
[ "$SATURN_BOOTSTRAP_RELEASE_VERSION" = "$SATURN_EXACT_RELEASE_VERSION" ] || die "Saturn release identity mismatch"
[ "$bytes" -le "$MAX_BUNDLE_BYTES" ] || die "bundle exceeds size policy"
case "$bundle_url" in https://*) ;; *) die "bundle URL must use HTTPS" ;; esac
curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 --connect-timeout 10 --max-time 300 --max-filesize "$MAX_BUNDLE_BYTES" "$bundle_url" -o "$work/bundle.zip"
actual=$(openssl dgst -sha256 "$work/bundle.zip" | awk '{print $NF}')
[ "$actual" = "$expected" ] || die "bundle digest mismatch"
extract_root=$INSTALL_ROOT
if [ "$existing_install" = true ]; then extract_root="$work/install"; fi
python3 - "$work/bundle.zip" "$extract_root" <<'PY'
import pathlib,sys,zipfile
archive,target=sys.argv[1:]; z=zipfile.ZipFile(archive)
for item in z.infolist():
  p=pathlib.PurePosixPath(item.filename)
  if p.is_absolute() or '..' in p.parts or item.is_dir(): raise SystemExit('unsafe bundle member')
pathlib.Path(target).mkdir(mode=0o755)
for item in z.infolist():
  output=pathlib.Path(target,*pathlib.PurePosixPath(item.filename).parts);output.parent.mkdir(parents=True,exist_ok=True);output.write_bytes(z.read(item));output.chmod(0o700 if item.filename.endswith('.sh') or item.filename.endswith('/updater-linux-amd64') else 0o600)
PY
[ -f "$extract_root/updater/install.sh" ] || die "release bundle is missing updater/install.sh"
[ -x "$extract_root/updater/updater-linux-amd64" ] || die "release bundle is missing updater/updater-linux-amd64"
[ -f "$extract_root/updater/systemd/updater.service" ] || die "release bundle is missing updater/systemd/updater.service"
for service in updater neptune gryphon; do
  [ -f "$extract_root/updater/release-trust/$service.pem" ] || die "release bundle is missing updater/release-trust/$service.pem"
done
if [ "$existing_install" = true ]; then
  backup_root="${INSTALL_ROOT}.previous-$(date -u +%Y%m%dT%H%M%SZ)"
  [ ! -e "$backup_root" ] || die "refresh backup already exists: $backup_root"
  mv "$INSTALL_ROOT" "$backup_root"
  if ! mv "$extract_root" "$INSTALL_ROOT"; then
    mv "$backup_root" "$INSTALL_ROOT"
    die "could not activate refreshed release; previous bundle was restored"
  fi
  printf '%s\n' "Previous prepared bundle preserved at $backup_root"
fi
[ -f "$INSTALL_ROOT/updater/install.sh" ] || die "release bundle is missing updater/install.sh"
[ -x "$INSTALL_ROOT/updater/updater-linux-amd64" ] || die "release bundle is missing updater/updater-linux-amd64"
[ -f "$INSTALL_ROOT/updater/systemd/updater.service" ] || die "release bundle is missing updater/systemd/updater.service"
for service in updater neptune gryphon; do
  [ -f "$INSTALL_ROOT/updater/release-trust/$service.pem" ] || die "release bundle is missing updater/release-trust/$service.pem"
done
install -m 0755 "$INSTALL_ROOT/infra/production/install.sh" /usr/local/sbin/vaultctl
ln -sfn /usr/local/sbin/vaultctl /usr/local/sbin/saturn-install
"$INSTALL_ROOT/infra/production/install.sh" "$BOOTSTRAP_MODE"
