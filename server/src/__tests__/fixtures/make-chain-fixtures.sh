#!/bin/sh
# Invented certificates and PDFs signed with them, for signatures-cms.test.ts. Run from this directory: ./make-chain-fixtures.sh
# Needs OpenSSL 3.4+ (x509 -not_before) and python3. Names and keys are made up; nothing here is real.
set -e
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cd "$work"
ec() { openssl ecparam -name prime256v1 -genkey -noout -out "$1.key"; }
ca() { # name, subject
  ec "$1"; openssl req -new -x509 -key "$1.key" -subj "$2" -days 3650 -out "$1.pem" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
}
leaf() { # name, ca, subject, extra x509 args...
  name=$1; issuer=$2; subj=$3; shift 3
  ec "$name"; openssl req -new -key "$name.key" -subj "$subj" -out "$name.csr"
  openssl x509 -req -in "$name.csr" -CA "$issuer.pem" -CAkey "$issuer.key" -CAcreateserial -out "$name.pem" "$@"
}
ca root "/CN=Example Test Root CA/O=Example Trust"
ca other "/CN=Another Test Root CA/O=Other Trust"
leaf good root "/GN=Ana/SN=Exemplu/CN=Ana Exemplu" -days 3650
leaf old root "/GN=Ion/SN=Vechi/CN=Ion Vechi" -not_before 20150101000000Z -not_after 20160101000000Z
leaf foreign other "/GN=Maria/SN=Altceva/CN=Maria Altceva" -days 3650
sign() { # leaf, out
  python3 "$HERE/make-signed-pdf.py" "$2" "$1.pem" "$1.key" "$work/root.pem"
}
HERE=$OLDPWD
cp "$HERE/make-signed-pdf.py" make.py
for who in good old foreign; do python3 make.py "$HERE/signed-chain-$who.pdf" "$who.pem" "$who.key" root.pem; done
openssl x509 -in root.pem -outform DER -out "$HERE/chain-root.der"
