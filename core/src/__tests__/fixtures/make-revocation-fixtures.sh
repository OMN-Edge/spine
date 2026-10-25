#!/bin/sh
# Invented certificates and PDFs whose signatures carry revocation lists, for signatures-cms.test.ts. Run from this directory:
# ./make-revocation-fixtures.sh. Needs OpenSSL 3.4+ and python3. Names and keys are made up. The lists are given dates relative to the moment
# this runs, because the signing time in each file is that moment: a list "issued after the signing" is dated an hour ahead, a "stale" one a day back.
set -e
HERE=$(pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cp make-signed-pdf.py "$work/make.py"
cd "$work"

when() { python3 -c "import datetime,sys;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=float(sys.argv[1]))).strftime('%y%m%d%H%M%SZ'))" "$1"; }
ec() { openssl ecparam -name prime256v1 -genkey -noout -out "$1.key"; }
authority() { ec "$1"; openssl req -new -x509 -key "$1.key" -subj "$2" -days 3650 -out "$1.pem" -sha256 \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"; }
leaf() { # name, issuer, subject
  ec "$1"; openssl req -new -key "$1.key" -subj "$3" -out "$1.csr"
  printf "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\n" > "$1.ext"
  openssl x509 -req -in "$1.csr" -CA "$2.pem" -CAkey "$2.key" -CAcreateserial -days 3650 -sha256 -extfile "$1.ext" -out "$1.pem" 2>/dev/null; }
serial() { openssl x509 -in "$1.pem" -noout -serial | sed 's/serial=//'; }
# ca-name, then index lines on stdin; writes <ca>.index and a config; crl <ca> <name> <lastupdate>
crl() {
  ca=$1; out=$2; last=$3
  printf "[ca]\ndefault_ca = c\n[c]\ndatabase = %s/%s.index\ncrlnumber = %s/%s.num\ndefault_md = sha256\ndefault_crl_days = 3650\ncertificate = %s/%s.pem\nprivate_key = %s/%s.key\n" \
    "$work" "$ca" "$work" "$ca" "$work" "$ca" "$work" "$ca" > "$ca.cnf"
  echo 01 > "$ca.num"
  openssl ca -config "$ca.cnf" -gencrl -crl_lastupdate "$last" -out "$out.pem" 2>/dev/null
  openssl crl -in "$out.pem" -outform DER -out "$out.der"
}
revoked_line() { printf "R\t360101000000Z\t%s\t%s\tunknown\t/CN=%s\n" "$3" "$1" "$2"; }

authority root_r "/CN=Example Revocation Test Root/O=Example Trust"
authority other_r "/CN=Another Revocation Test Root/O=Other Trust"
leaf lgood root_r "/GN=Ioana/SN=Valabila/CN=Ioana Valabila"
leaf lrev root_r "/GN=Vlad/SN=Revocat/CN=Vlad Revocat"
leaf llater root_r "/GN=Alina/SN=Revocata/CN=Alina Revocata"
leaf lstale root_r "/GN=Mircea/SN=Vechi/CN=Mircea Vechi"
leaf lforged root_r "/GN=Elena/SN=Falsa/CN=Elena Falsa"
leaf lother root_r "/GN=Tudor/SN=Altcineva/CN=Tudor Altcineva"

# The list the issuer publishes after the signing (an hour ahead): Vlad was revoked a day before, Alina is revoked a month after
{ revoked_line "$(serial lrev)" lrev "$(when -24)"; revoked_line "$(serial llater)" llater "$(when 720)"; } > root_r.index
crl root_r fresh "$(when 1)"
# The same issuer's list from a day before the signing, naming nobody
: > root_r.index
crl root_r stale "$(when -24)"
# A list from another authority that names Tudor: it is not the issuer's, so it says nothing about him
{ revoked_line "$(serial lother)" lother "$(when -24)"; } > other_r.index
crl other_r otherlist "$(when 1)"
# The fresh list with its signature damaged: it names Elena as revoked, but cannot be trusted to say so
{ revoked_line "$(serial lforged)" lforged "$(when -24)"; } > root_r.index
crl root_r forged "$(when 1)"
python3 - <<'PY'
b = bytearray(open("forged.der", "rb").read()); b[-1] ^= 0xff; open("forged.der", "wb").write(b)
PY

sign_with() { out=$1; who=$2; shift 2; python3 make.py "$HERE/$out" "$who.pem" "$who.key" - "$@"; }
sign_with signed-crl-good.pdf lgood fresh.der
sign_with signed-crl-revoked.pdf lrev fresh.der
sign_with signed-crl-revoked-later.pdf llater fresh.der
sign_with signed-crl-stale.pdf lstale stale.der
sign_with signed-crl-none.pdf lgood
sign_with signed-crl-forged.pdf lforged forged.der
sign_with signed-crl-other-issuer.pdf lother otherlist.der
openssl x509 -in root_r.pem -outform DER -out "$HERE/chain-root-revocation.der"
