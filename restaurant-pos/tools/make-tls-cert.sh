#!/bin/sh
# Create a self-signed HTTPS certificate for serving the app to other computers on the LAN.
# Usage: sh tools/make-tls-cert.sh 192.168.1.20   (the server computer's IP address)
set -e
IP="${1:?Give the server computer IP address, e.g. 192.168.1.20}"
DIR="$(dirname "$0")/../data/tls"
mkdir -p "$DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 1825 \
  -keyout "$DIR/server-key.pem" -out "$DIR/server-cert.pem" \
  -subj "/CN=Restaurant POS" \
  -addext "subjectAltName=IP:$IP,DNS:localhost,IP:127.0.0.1"
echo "Created $DIR/server-cert.pem and server-key.pem"
echo "Start with: TLS_CERT=data/tls/server-cert.pem TLS_KEY=data/tls/server-key.pem npm start"
echo "Then install server-cert.pem as a trusted root on each cashier computer."
