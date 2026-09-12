#!/bin/sh
set -eu
umask 077

REPOSITORY=${SATURN_RELEASE_REPOSITORY:-psewdon1m-exocortex/saturn}
MANIFEST_URL=${VAULT_MANIFEST_URL:-}
TRUSTED_PUBLIC_KEY=${VAULT_RELEASE_PUBLIC_KEY:-/etc/vault/release-public-key.pem}
RSA_TRUSTED_PUBLIC_KEY=${EXOCORTEX_SATURN_RELEASE_TRUST_FILE:-/etc/exocortex/release-trust/saturn.pem}
INSTALL_ROOT=${VAULT_INSTALL_ROOT:-/opt/vault}
MAX_MANIFEST_BYTES=1048576
MAX_BUNDLE_BYTES=104857600

die() { printf '%s\n' "saturn bootstrap: $1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"; }
[ "$(id -u)" -eq 0 ] || die "bootstrap requires root"
[ ! -e "$INSTALL_ROOT" ] || die "installation already exists; use the updater or explicit repair"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl openssl python3 unzip
fi
need curl; need openssl; need python3; need unzip

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
if [ -z "$MANIFEST_URL" ]; then
  curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 \
    "https://api.github.com/repos/$REPOSITORY/releases?per_page=100" -o "$work/releases.json"
  MANIFEST_URL=$(python3 - "$work/releases.json" <<'PYVERSION'
import json,re,sys
releases=json.load(open(sys.argv[1],encoding='utf8')); candidates=[]
for release in releases:
  match=re.fullmatch(r'saturn-v(\d+)\.(\d+)\.(\d+)',str(release.get('tag_name') or ''))
  if match and not release.get('draft') and not release.get('prerelease'):
    for asset in release.get('assets') or []:
      if asset.get('name')=='release-manifest.json': candidates.append((tuple(map(int,match.groups())),asset['browser_download_url']))
if not candidates: raise SystemExit('no stable saturn-v* release is available')
print(max(candidates,key=lambda item:item[0])[1])
PYVERSION
  )
fi
case "$MANIFEST_URL" in https://*) ;; *) die "manifest URL must use HTTPS" ;; esac
release_base=${MANIFEST_URL%/release-manifest.json}
curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 --connect-timeout 10 --max-time 120 --max-filesize "$MAX_MANIFEST_BYTES" "$MANIFEST_URL" -o "$work/manifest.json"
candidate_trust_file="$TRUSTED_PUBLIC_KEY"
bootstrap_trust=false
if [ ! -f "$TRUSTED_PUBLIC_KEY" ]; then
  candidate_trust_file="$work/saturn-ed25519.pem"
  curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 --max-filesize 16384 "$release_base/saturn-ed25519.pem" -o "$candidate_trust_file"
  bootstrap_trust=true
fi
python3 - "$work/manifest.json" "$candidate_trust_file" "$work" <<'PY'
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
if [ "$bootstrap_trust" = true ]; then
  install -d -o root -g root -m 0755 "$(dirname "$TRUSTED_PUBLIC_KEY")"
  install -o root -g root -m 0644 "$candidate_trust_file" "$TRUSTED_PUBLIC_KEY"
fi

if [ ! -f "$RSA_TRUSTED_PUBLIC_KEY" ]; then
  curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 --max-filesize 16384 "$release_base/saturn.pem" -o "$work/saturn.pem"
  curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 --max-filesize "$MAX_MANIFEST_BYTES" "$release_base/saturn-release.json" -o "$work/saturn-release.json"
  curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 --max-filesize 16384 "$release_base/saturn-release.json.sig.json" -o "$work/saturn-release.json.sig.json"
  python3 - "$work/saturn-release.json" "$work/saturn-release.json.sig.json" "$work/saturn.pem" <<'PYRSA'
import base64,hashlib,json,pathlib,re,subprocess,sys,tempfile
manifest,envelope,key=map(pathlib.Path,sys.argv[1:])
signed=json.loads(envelope.read_text(encoding='utf8'))
data=json.loads(manifest.read_text(encoding='utf8'))
if data.get('service')!='saturn' or signed.get('schema')!='exocortex.release-signature.v1' or signed.get('algorithm')!='RSA-PSS-SHA256': raise SystemExit('invalid Saturn updater manifest identity')
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
  install -o root -g root -m 0644 "$work/saturn.pem" "$RSA_TRUSTED_PUBLIC_KEY"
fi
fields=$(python3 -c "import json; p=json.load(open('$work/manifest.json'))['payload']; print(p['bundle']['sha256'][7:]); print(p['bundle']['bytes']); print(p['bundle'].get('url',''))")
expected=$(printf '%s\n' "$fields" | sed -n '1p')
bytes=$(printf '%s\n' "$fields" | sed -n '2p')
bundle_url=$(printf '%s\n' "$fields" | sed -n '3p')
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
