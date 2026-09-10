#!/bin/sh
set -eu
umask 077

MANIFEST_URL=${VAULT_MANIFEST_URL:-}
TRUSTED_PUBLIC_KEY=${VAULT_RELEASE_PUBLIC_KEY:-/etc/vault/release-public-key.pem}
INSTALL_ROOT=${VAULT_INSTALL_ROOT:-/opt/vault}
MAX_MANIFEST_BYTES=1048576
MAX_BUNDLE_BYTES=104857600

die() { printf '%s\n' "saturn bootstrap: $1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"; }
[ "$(id -u)" -eq 0 ] || die "bootstrap requires root"
[ -n "$MANIFEST_URL" ] || die "VAULT_MANIFEST_URL is required"
case "$MANIFEST_URL" in https://*) ;; *) die "manifest URL must use HTTPS" ;; esac
[ ! -e "$INSTALL_ROOT" ] || die "installation already exists; use the updater or explicit repair"
need curl; need openssl; need python3; need unzip
[ -f "$TRUSTED_PUBLIC_KEY" ] || die "trusted release public key is missing"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 --connect-timeout 10 --max-time 120 --max-filesize "$MAX_MANIFEST_BYTES" "$MANIFEST_URL" -o "$work/manifest.json"
python3 - "$work/manifest.json" "$TRUSTED_PUBLIC_KEY" "$work" <<'PY'
import base64,hashlib,json,pathlib,subprocess,sys
manifest_path,key_path,out=sys.argv[1:]
m=json.loads(pathlib.Path(manifest_path).read_text())
p=m.get('payload',{}); s=m.get('signature',{})
if p.get('schema')!='vault.release-manifest.v1' or p.get('componentRole')!='vault-gateway' or s.get('algorithm')!='Ed25519': raise SystemExit('invalid manifest identity')
def canonical(v):
  if isinstance(v,dict): return '{'+','.join(json.dumps(k,separators=(',',':'))+':'+canonical(v[k]) for k in sorted(v))+'}'
  if isinstance(v,list): return '['+','.join(canonical(x) for x in v)+']'
  return json.dumps(v,separators=(',',':'))
pathlib.Path(out,'payload').write_bytes(canonical(p).encode());pathlib.Path(out,'signature').write_bytes(base64.b64decode(s['value']))
r=subprocess.run(['openssl','pkeyutl','-verify','-pubin','-inkey',key_path,'-rawin','-in',str(pathlib.Path(out,'payload')),'-sigfile',str(pathlib.Path(out,'signature'))])
if r.returncode: raise SystemExit('manifest signature verification failed')
print(p['bundle']['sha256'][7:]);print(p['bundle']['bytes']);print(p['bundle'].get('url',''))
PY
set -- $(python3 -c "import json; p=json.load(open('$work/manifest.json'))['payload']; print(p['bundle']['sha256'][7:],p['bundle']['bytes'],p['bundle'].get('url',''))")
expected=$1; bytes=$2; bundle_url=$3
[ "$bytes" -le "$MAX_BUNDLE_BYTES" ] || die "bundle exceeds size policy"
case "$bundle_url" in https://*) ;; *) die "bundle URL must use HTTPS" ;; esac
curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 --connect-timeout 10 --max-time 300 --max-filesize "$MAX_BUNDLE_BYTES" "$bundle_url" -o "$work/bundle.zip"
actual=$(openssl dgst -sha256 "$work/bundle.zip" | awk '{print $NF}')
[ "$actual" = "$expected" ] || die "bundle digest mismatch"
python3 - "$work/bundle.zip" "$INSTALL_ROOT" <<'PY'
import pathlib,sys,zipfile
archive,target=sys.argv[1:]; z=zipfile.ZipFile(archive)
for item in z.infolist():
  p=pathlib.PurePosixPath(item.filename)
  if p.is_absolute() or '..' in p.parts or item.is_dir(): raise SystemExit('unsafe bundle member')
pathlib.Path(target).mkdir(mode=0o755)
for item in z.infolist():
  output=pathlib.Path(target,*pathlib.PurePosixPath(item.filename).parts);output.parent.mkdir(parents=True,exist_ok=True);output.write_bytes(z.read(item));output.chmod(0o700 if item.filename.endswith('.sh') or item.filename.endswith('/updater-linux-amd64') else 0o600)
PY
[ -f "$INSTALL_ROOT/updater/install.sh" ] || die "release bundle is missing updater/install.sh"
[ -x "$INSTALL_ROOT/updater/updater-linux-amd64" ] || die "release bundle is missing updater/updater-linux-amd64"
[ -f "$INSTALL_ROOT/updater/systemd/updater.service" ] || die "release bundle is missing updater/systemd/updater.service"
install -m 0755 "$INSTALL_ROOT/infra/production/install.sh" /usr/local/sbin/vaultctl
ln -sfn /usr/local/sbin/vaultctl /usr/local/sbin/saturn-install
"$INSTALL_ROOT/infra/production/install.sh" prepare
